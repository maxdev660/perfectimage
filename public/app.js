'use strict';

const state = {
  route: 'home',
  images: [],
  page: 1,
  limit: 48,
  total: 0,
  hasMore: false,
  search: '',
  sort: 'newest',
  selectedFile: null,
  selectedObjectUrl: null,
  selectedDimensions: { width: 0, height: 0 },
  currentImage: null,
  deleteTokens: loadDeleteTokens(),
};

const $ = id => document.getElementById(id);
const pages = [...document.querySelectorAll('[data-page]')];
const routeButtons = [...document.querySelectorAll('[data-route]')];
const navLinks = [...document.querySelectorAll('.nav-link[data-route]')];

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function relativeDate(value) {
  const diff = Date.now() - Number(value);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))}h ago`;
  if (diff < 604_800_000) return `${Math.max(1, Math.floor(diff / 86_400_000))}d ago`;
  return new Date(Number(value)).toLocaleDateString();
}

function isToday(value) {
  const a = new Date(Number(value));
  const b = new Date();
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}

function toast(title, message = '') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<strong>${escapeHtml(title)}</strong>${message ? `<span>${escapeHtml(message)}</span>` : ''}`;
  $('toastStack').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(label || 'Copied', text.length > 90 ? `${text.slice(0, 87)}…` : text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    toast(label || 'Copied');
  }
}

function shareUrl(image) { return image.publicUrl || `${location.origin}/image/${encodeURIComponent(image.id)}`; }
function rawUrl(image) { return image.rawUrl || image.url || `${location.origin}/raw/${encodeURIComponent(image.id)}`; }
function mcCommand(image) { return `/image ${shareUrl(image)}`; }

function loadDeleteTokens() {
  try { return JSON.parse(localStorage.getItem('perfectSmpImageDeleteTokens') || '{}') || {}; }
  catch { return {}; }
}
function saveDeleteTokens() { localStorage.setItem('perfectSmpImageDeleteTokens', JSON.stringify(state.deleteTokens)); }

function setRoute(route, imageId = null, push = true) {
  state.route = route;
  pages.forEach(page => page.classList.toggle('active', page.dataset.page === route));
  navLinks.forEach(link => link.classList.toggle('active', link.dataset.route === route));
  if (push) {
    const path = route === 'image' && imageId ? `/image/${encodeURIComponent(imageId)}` : route === 'home' ? '/' : `/#${route}`;
    history.pushState({ route, imageId }, '', path);
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (route === 'gallery') refreshGallery(true);
  if (route === 'image' && imageId) openDetail(imageId);
}

function parseLocation() {
  const imageMatch = location.pathname.match(/^\/image\/([A-Za-z0-9_-]+)$/);
  if (imageMatch) { setRoute('image', imageMatch[1], false); return; }
  const hash = location.hash.replace(/^#/, '');
  if (['gallery', 'upload'].includes(hash)) { setRoute(hash, null, false); return; }
  setRoute('home', null, false);
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { Accept: 'application/json', ...(options.headers || {}) }, ...options });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { const body = await response.json(); message = body.message || body.error || message; } catch {}
    throw new Error(message);
  }
  return response.json();
}

function cardHtml(image) {
  const tags = (image.tags || []).slice(0, 3);
  return `<article class="image-card" data-id="${escapeHtml(image.id)}">
    <div class="card-image" data-open="${escapeHtml(image.id)}"><img src="${escapeHtml(image.thumbnailUrl || image.url)}" alt="${escapeHtml(image.name)}" loading="lazy"><span class="card-badge">${escapeHtml(image.uploaderName || 'Guest')}</span></div>
    <div class="card-body">
      <div class="card-title-row"><div class="card-title" title="${escapeHtml(image.name)}">${escapeHtml(image.name)}</div></div>
      <div class="card-author">posted by ${escapeHtml(image.uploaderName || 'Guest')}</div>
      <div class="card-meta"><span>${formatBytes(image.size)}</span><span>·</span><span>${relativeDate(image.created)}</span>${image.width && image.height ? `<span>·</span><span>${image.width}×${image.height}</span>` : ''}</div>
      ${tags.length ? `<div class="card-tags">${tags.map(tag => `<span class="card-tag">#${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
      <div class="card-actions"><button data-copy-link="${escapeHtml(image.id)}">Copy link</button><button class="primary" data-copy-command="${escapeHtml(image.id)}">/image</button></div>
    </div>
  </article>`;
}

function bindCards(root, images) {
  const map = new Map(images.map(image => [image.id, image]));
  root.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => setRoute('image', el.dataset.open)));
  root.querySelectorAll('[data-copy-link]').forEach(el => el.addEventListener('click', () => { const image = map.get(el.dataset.copyLink); if (image) copy(shareUrl(image), 'Link copied'); }));
  root.querySelectorAll('[data-copy-command]').forEach(el => el.addEventListener('click', () => { const image = map.get(el.dataset.copyCommand); if (image) copy(mcCommand(image), '/image copied'); }));
}

function renderEmpty(root, title = 'No images yet', copyText = 'Be the first to post something.') {
  root.innerHTML = `<div class="empty"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(copyText)}</span></div>`;
}

async function loadHome() {
  try {
    const result = await api('/api/images?limit=12&sort=newest');
    const images = result.images || [];
    state.images = images;
    state.total = result.total || images.length;
    $('statImages').textContent = state.total.toLocaleString();
    $('statToday').textContent = images.filter(image => isToday(image.created)).length.toString();
    $('statStorage').textContent = formatBytes(images.reduce((sum, image) => sum + Number(image.size || 0), 0));
    const recent = images.slice(0, 8);
    if (!recent.length) renderEmpty($('homeGallery'));
    else { $('homeGallery').innerHTML = recent.map(cardHtml).join(''); bindCards($('homeGallery'), recent); }
    const hero = images.slice(0, 4);
    $('heroGrid').innerHTML = Array.from({ length: 4 }, (_, i) => hero[i] ? `<div class="hero-tile" data-hero="${escapeHtml(hero[i].id)}"><img src="${escapeHtml(hero[i].thumbnailUrl || hero[i].url)}" alt="${escapeHtml(hero[i].name)}"></div>` : `<div class="hero-tile placeholder"></div>`).join('');
    $('heroGrid').querySelectorAll('[data-hero]').forEach(el => el.addEventListener('click', () => setRoute('image', el.dataset.hero)));
    $('apiStatus').textContent = 'public API online';
  } catch (error) {
    $('apiStatus').textContent = 'API unavailable';
    renderEmpty($('homeGallery'), 'Could not load uploads', error.message);
    toast('Could not load public gallery', error.message);
  }
}

async function refreshGallery(reset = false) {
  if (reset) { state.page = 1; state.images = []; }
  const params = new URLSearchParams({ page: String(state.page), limit: String(state.limit), sort: state.sort });
  if (state.search.trim()) params.set('search', state.search.trim());
  $('loadMoreButton').disabled = true;
  $('loadMoreButton').textContent = 'Loading…';
  try {
    const result = await api(`/api/images?${params}`);
    state.images = reset ? result.images : [...state.images, ...result.images];
    state.total = result.total;
    state.hasMore = result.hasMore;
    if (!state.images.length) renderEmpty($('publicGallery'), state.search ? 'No matching uploads' : 'No uploads yet', state.search ? 'Try a different search.' : 'Upload the first public image.');
    else { $('publicGallery').innerHTML = state.images.map(cardHtml).join(''); bindCards($('publicGallery'), state.images); }
    $('loadMoreButton').classList.toggle('hidden', !state.hasMore);
    $('loadMoreButton').disabled = false;
    $('loadMoreButton').textContent = 'Load more';
  } catch (error) {
    renderEmpty($('publicGallery'), 'Could not load gallery', error.message);
    $('loadMoreButton').classList.add('hidden');
  }
}

function resetUpload() {
  state.selectedFile = null;
  state.selectedDimensions = { width: 0, height: 0 };
  if (state.selectedObjectUrl) URL.revokeObjectURL(state.selectedObjectUrl);
  state.selectedObjectUrl = null;
  $('fileInput').value = '';
  $('previewImage').src = '';
  $('previewShell').classList.add('hidden');
  $('dropEmpty').classList.remove('hidden');
  $('selectedFilename').textContent = 'No image selected';
  $('selectedMeta').textContent = 'Choose an image first.';
  $('titleInput').value = '';
  $('tagsInput').value = '';
  $('submitUploadButton').disabled = true;
  $('uploadProgress').classList.add('hidden');
  $('progressBar').style.width = '0%';
  $('progressPercent').textContent = '0%';
}

async function chooseFile(file) {
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { toast('Unsupported image', 'Use PNG, JPG or WEBP.'); return; }
  if (file.size > 15 * 1024 * 1024) { toast('Image too large', 'Maximum size is 15 MB.'); return; }
  resetUpload();
  state.selectedFile = file;
  state.selectedObjectUrl = URL.createObjectURL(file);
  $('previewImage').src = state.selectedObjectUrl;
  $('previewShell').classList.remove('hidden');
  $('dropEmpty').classList.add('hidden');
  $('selectedFilename').textContent = file.name;
  $('titleInput').value = file.name.replace(/\.[^.]+$/, '');
  $('submitUploadButton').disabled = false;
  const image = new Image();
  image.onload = () => { state.selectedDimensions = { width: image.naturalWidth, height: image.naturalHeight }; $('selectedMeta').textContent = `${formatBytes(file.size)} · ${file.type.replace('image/', '').toUpperCase()} · ${image.naturalWidth}×${image.naturalHeight}`; };
  image.src = state.selectedObjectUrl;
}

function uploadSelected() {
  if (!state.selectedFile) return;
  const form = new FormData();
  form.append('image', state.selectedFile, state.selectedFile.name);
  form.append('name', $('titleInput').value.trim());
  form.append('uploader', $('uploaderInput').value.trim());
  form.append('tags', JSON.stringify($('tagsInput').value.split(',').map(v => v.trim()).filter(Boolean)));
  form.append('width', String(state.selectedDimensions.width || 0));
  form.append('height', String(state.selectedDimensions.height || 0));
  localStorage.setItem('perfectSmpUploaderName', $('uploaderInput').value.trim());
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/images');
  xhr.setRequestHeader('Accept', 'application/json');
  $('uploadProgress').classList.remove('hidden');
  $('submitUploadButton').disabled = true;
  $('cancelUploadButton').disabled = true;
  xhr.upload.onprogress = event => { if (!event.lengthComputable) return; const percent = Math.round((event.loaded / event.total) * 100); $('progressBar').style.width = `${percent}%`; $('progressPercent').textContent = `${percent}%`; $('progressText').textContent = percent < 100 ? 'Uploading…' : 'Saving…'; };
  xhr.onerror = () => finishUploadError('Network error');
  xhr.onload = () => {
    if (xhr.status < 200 || xhr.status >= 300) { let message = `Upload failed (${xhr.status})`; try { const body = JSON.parse(xhr.responseText); message = body.message || body.error || message; } catch {} finishUploadError(message); return; }
    const body = JSON.parse(xhr.responseText);
    const uploaded = body.image;
    if (body.deleteToken) { state.deleteTokens[uploaded.id] = body.deleteToken; saveDeleteTokens(); }
    $('progressBar').style.width = '100%'; $('progressPercent').textContent = '100%'; $('progressText').textContent = 'Published';
    setTimeout(() => { resetUpload(); $('cancelUploadButton').disabled = false; toast('Image posted publicly', uploaded.name); loadHome(); setRoute('image', uploaded.id); }, 250);
  };
  xhr.send(form);
}

function finishUploadError(message) {
  $('submitUploadButton').disabled = false;
  $('cancelUploadButton').disabled = false;
  $('uploadProgress').classList.add('hidden');
  toast('Upload failed', message);
}

async function openDetail(id) {
  try {
    const result = await api(`/api/images/${encodeURIComponent(id)}`);
    const image = result.image;
    state.currentImage = image;
    $('detailImage').src = image.url;
    $('detailImage').alt = image.name;
    $('detailTitle').textContent = image.name;
    $('detailAuthor').textContent = `Posted by ${image.uploaderName || 'Guest'}`;
    $('detailMeta').textContent = [formatBytes(image.size), image.width && image.height ? `${image.width}×${image.height}` : '', image.type, formatDate(image.created)].filter(Boolean).join(' · ');
    $('detailTags').innerHTML = (image.tags || []).length ? image.tags.map(tag => `<span class="card-tag">#${escapeHtml(tag)}</span>`).join('') : '<span class="card-tag">no tags</span>';
    $('shareUrlCode').textContent = shareUrl(image);
    $('commandCode').textContent = mcCommand(image);
    $('deleteImageButton').classList.toggle('hidden', !state.deleteTokens[image.id]);
  } catch (error) {
    toast('Image not found', error.message);
    setRoute('gallery');
  }
}

async function deleteCurrent() {
  const image = state.currentImage;
  if (!image) return;
  const token = state.deleteTokens[image.id];
  if (!token) { toast('Delete unavailable', 'This browser does not own the delete token for this upload.'); return; }
  if (!confirm(`Delete "${image.name}" permanently?`)) return;
  try {
    await api(`/api/images/${encodeURIComponent(image.id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    delete state.deleteTokens[image.id]; saveDeleteTokens();
    toast('Image deleted', image.name); loadHome(); setRoute('gallery');
  } catch (error) { toast('Delete failed', error.message); }
}

function openViewer(image) {
  $('viewerImage').src = image.url;
  $('viewerImage').alt = image.name;
  $('viewerTitle').textContent = image.name;
  $('viewerInfo').textContent = `${image.uploaderName || 'Guest'} · ${formatBytes(image.size)} · ${formatDate(image.created)}`;
  $('viewer').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeViewer() { $('viewer').classList.add('hidden'); $('viewerImage').src = ''; document.body.style.overflow = ''; }

routeButtons.forEach(button => button.addEventListener('click', event => { if (button.tagName === 'A') event.preventDefault(); setRoute(button.dataset.route); }));
$('refreshButton').addEventListener('click', async () => { await loadHome(); if (state.route === 'gallery') await refreshGallery(true); toast('Gallery refreshed'); });
$('searchInput').addEventListener('input', () => { state.search = $('searchInput').value; clearTimeout(window.__searchTimer); window.__searchTimer = setTimeout(() => refreshGallery(true), 250); });
$('sortSelect').addEventListener('change', () => { state.sort = $('sortSelect').value; refreshGallery(true); });
$('loadMoreButton').addEventListener('click', () => { state.page += 1; refreshGallery(false); });
$('chooseFileButton').addEventListener('click', event => { event.stopPropagation(); $('fileInput').click(); });
$('fileInput').addEventListener('change', () => chooseFile($('fileInput').files[0]));
$('dropZone').addEventListener('click', event => { if (event.target.closest('button')) return; if (!state.selectedFile) $('fileInput').click(); });
['dragenter', 'dragover'].forEach(type => $('dropZone').addEventListener(type, event => { event.preventDefault(); $('dropZone').classList.add('dragging'); }));
['dragleave', 'drop'].forEach(type => $('dropZone').addEventListener(type, event => { event.preventDefault(); $('dropZone').classList.remove('dragging'); }));
$('dropZone').addEventListener('drop', event => chooseFile(event.dataTransfer.files[0]));
$('cancelUploadButton').addEventListener('click', resetUpload);
$('submitUploadButton').addEventListener('click', uploadSelected);
$('copyImageCommandButton').addEventListener('click', () => state.currentImage && copy(mcCommand(state.currentImage), '/image copied'));
$('copyShareLinkButton').addEventListener('click', () => state.currentImage && copy(shareUrl(state.currentImage), 'Page link copied'));
$('copyRawLinkButton').addEventListener('click', () => state.currentImage && copy(rawUrl(state.currentImage), 'Raw image link copied'));
$('deleteImageButton').addEventListener('click', deleteCurrent);
$('detailImage').addEventListener('click', () => state.currentImage && openViewer(state.currentImage));
$('closeViewerButton').addEventListener('click', closeViewer);
$('viewer').addEventListener('click', event => { if (event.target === $('viewer') || event.target === $('viewerImage').parentElement) closeViewer(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeViewer(); });
window.addEventListener('popstate', parseLocation);

$('uploaderInput').value = localStorage.getItem('perfectSmpUploaderName') || '';
loadHome();
parseLocation();
