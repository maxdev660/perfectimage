package de.perfectsmp.images;

import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.HumanEntity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerItemHeldEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerSwapHandItemsEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.MapMeta;
import org.bukkit.map.MapCanvas;
import org.bukkit.map.MapRenderer;
import org.bukkit.map.MapView;
import org.bukkit.plugin.java.JavaPlugin;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class PerfectSMPImagesPlugin extends JavaPlugin implements Listener {
    private static final Pattern SAFE_ID = Pattern.compile("^[A-Za-z0-9_-]{6,128}$");
    private static final Pattern PATH_ID = Pattern.compile("/(?:image|raw|api/images)/([A-Za-z0-9_-]{6,128})(?:/)?$");

    private final Map<UUID, ViewerSession> viewerSessions = new ConcurrentHashMap<>();

    private HttpClient httpClient;
    private String websiteUrl;
    private String allowedHost;
    private int timeoutSeconds;
    private int maxDownloadBytes;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        reloadSettings();

        httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(timeoutSeconds))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();

        Bukkit.getPluginManager().registerEvents(this, this);
        getLogger().info("PerfectSMPImages enabled. Website: " + websiteUrl);
    }

    @Override
    public void onDisable() {
        for (UUID uuid : new ArrayList<>(viewerSessions.keySet())) {
            Player player = Bukkit.getPlayer(uuid);
            if (player != null) {
                restoreViewer(player, false);
            }
        }
        viewerSessions.clear();
    }

    private void reloadSettings() {
        websiteUrl = trimSlash(getConfig().getString("website-url", "https://perfect-smp-images.example.workers.dev"));
        timeoutSeconds = Math.max(3, Math.min(30, getConfig().getInt("request-timeout-seconds", 12)));
        maxDownloadBytes = Math.max(1024 * 1024, getConfig().getInt("max-download-bytes", 15 * 1024 * 1024));

        String configuredHost = getConfig().getString("allowed-host", "");
        if (configuredHost != null && !configuredHost.isBlank()) {
            allowedHost = configuredHost.trim().toLowerCase(Locale.ROOT);
        } else {
            try {
                allowedHost = new URI(websiteUrl).getHost().toLowerCase(Locale.ROOT);
            } catch (Exception ignored) {
                allowedHost = "";
            }
        }
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        String name = command.getName().toLowerCase(Locale.ROOT);

        switch (name) {
            case "imagewebsite" -> {
                sendWebsite(sender, websiteUrl, "OPEN PERFECT SMP IMAGES");
                return true;
            }
            case "uploadimage" -> {
                sendWebsite(sender, websiteUrl + "/#upload", "UPLOAD AN IMAGE");
                return true;
            }
            case "image" -> {
                if (!(sender instanceof Player player)) {
                    sender.sendMessage("This command can only be used by a player.");
                    return true;
                }
                if (args.length != 1) {
                    player.sendMessage("§eUsage: /image <Perfect SMP Images link or id>");
                    return true;
                }
                String id = extractImageId(args[0]);
                if (id == null) {
                    player.sendMessage("§cThat is not a valid Perfect SMP Images link/id.");
                    return true;
                }
                validateAndBroadcast(player, id);
                return true;
            }
            case "showimage" -> {
                if (!(sender instanceof Player player)) {
                    sender.sendMessage("This command can only be used by a player.");
                    return true;
                }
                if (args.length != 1) {
                    player.sendMessage("§eUsage: /showimage <id>");
                    return true;
                }
                String id = extractImageId(args[0]);
                if (id == null) {
                    player.sendMessage("§cInvalid image id.");
                    return true;
                }
                loadAndShowImage(player, id);
                return true;
            }
            case "closeimage" -> {
                if (sender instanceof Player player) {
                    restoreViewer(player, true);
                }
                return true;
            }
            default -> {
                return false;
            }
        }
    }

    private void sendWebsite(CommandSender sender, String url, String label) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage(url);
            return;
        }

        String json = "{\"text\":\"\",\"extra\":[" +
                "{\"text\":\"Perfect SMP Images  \",\"color\":\"gold\",\"bold\":true}," +
                "{\"text\":\"[" + jsonEscape(label) + "]\",\"color\":\"yellow\",\"bold\":true," +
                "\"clickEvent\":{\"action\":\"open_url\",\"value\":\"" + jsonEscape(url) + "\"}," +
                "\"hoverEvent\":{\"action\":\"show_text\",\"contents\":{\"text\":\"" + jsonEscape(url) + "\",\"color\":\"gray\"}}}" +
                "]}";
        tellraw(player, json);
    }

    private void validateAndBroadcast(Player sender, String id) {
        sender.sendMessage("§7Checking image...");
        HttpRequest request = HttpRequest.newBuilder(URI.create(rawUrl(id)))
                .timeout(Duration.ofSeconds(timeoutSeconds))
                .method("HEAD", HttpRequest.BodyPublishers.noBody())
                .build();

        httpClient.sendAsync(request, HttpResponse.BodyHandlers.discarding())
                .whenComplete((response, error) -> Bukkit.getScheduler().runTask(this, () -> {
                    if (!sender.isOnline()) return;
                    if (error != null || response == null || response.statusCode() < 200 || response.statusCode() >= 300) {
                        sender.sendMessage("§cImage not found or website unavailable.");
                        return;
                    }
                    broadcastImage(sender, id);
                }));
    }

    private void broadcastImage(Player sender, String id) {
        String page = websiteUrl + "/image/" + id;
        String json = "{\"text\":\"\",\"extra\":[" +
                "{\"text\":\"🖼 \",\"color\":\"yellow\"}," +
                "{\"text\":\"" + jsonEscape(sender.getName()) + "\",\"color\":\"white\",\"bold\":true}," +
                "{\"text\":\" posted an image  \",\"color\":\"gray\"}," +
                "{\"text\":\"[OPEN WEBSITE]\",\"color\":\"yellow\",\"bold\":true," +
                "\"clickEvent\":{\"action\":\"open_url\",\"value\":\"" + jsonEscape(page) + "\"}}," +
                "{\"text\":\"  \",\"color\":\"gray\"}," +
                "{\"text\":\"[SHOW INGAME]\",\"color\":\"green\",\"bold\":true," +
                "\"clickEvent\":{\"action\":\"run_command\",\"value\":\"/showimage " + jsonEscape(id) + "\"}," +
                "\"hoverEvent\":{\"action\":\"show_text\",\"contents\":{\"text\":\"Open as a temporary Minecraft map\",\"color\":\"green\"}}}" +
                "]}";

        for (Player player : Bukkit.getOnlinePlayers()) {
            tellraw(player, json);
        }
    }

    private void loadAndShowImage(Player player, String id) {
        player.sendMessage("§7Loading image...");

        HttpRequest request = HttpRequest.newBuilder(URI.create(rawUrl(id)))
                .timeout(Duration.ofSeconds(timeoutSeconds))
                .GET()
                .build();

        httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofByteArray())
                .whenComplete((response, error) -> {
                    if (error != null || response == null) {
                        Bukkit.getScheduler().runTask(this, () -> {
                            if (player.isOnline()) player.sendMessage("§cCould not download the image.");
                        });
                        return;
                    }

                    if (response.statusCode() < 200 || response.statusCode() >= 300) {
                        Bukkit.getScheduler().runTask(this, () -> {
                            if (player.isOnline()) player.sendMessage("§cImage not found.");
                        });
                        return;
                    }

                    byte[] bytes = response.body();
                    if (bytes == null || bytes.length == 0 || bytes.length > maxDownloadBytes) {
                        Bukkit.getScheduler().runTask(this, () -> {
                            if (player.isOnline()) player.sendMessage("§cImage is empty or too large.");
                        });
                        return;
                    }

                    try {
                        BufferedImage original = ImageIO.read(new ByteArrayInputStream(bytes));
                        if (original == null) throw new IllegalArgumentException("Unsupported image format");
                        BufferedImage mapImage = fitToMap(original);
                        Bukkit.getScheduler().runTask(this, () -> {
                            if (player.isOnline()) showMap(player, id, mapImage);
                        });
                    } catch (Exception exception) {
                        Bukkit.getScheduler().runTask(this, () -> {
                            if (player.isOnline()) player.sendMessage("§cCould not decode this image.");
                        });
                    }
                });
    }

    private BufferedImage fitToMap(BufferedImage source) {
        BufferedImage target = new BufferedImage(128, 128, BufferedImage.TYPE_INT_ARGB);
        Graphics2D graphics = target.createGraphics();
        graphics.setColor(Color.BLACK);
        graphics.fillRect(0, 0, 128, 128);
        graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
        graphics.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        graphics.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);

        double scale = Math.min(128.0 / source.getWidth(), 128.0 / source.getHeight());
        int width = Math.max(1, (int) Math.round(source.getWidth() * scale));
        int height = Math.max(1, (int) Math.round(source.getHeight() * scale));
        int x = (128 - width) / 2;
        int y = (128 - height) / 2;
        graphics.drawImage(source, x, y, width, height, null);
        graphics.dispose();
        return target;
    }

    private void showMap(Player player, String id, BufferedImage image) {
        restoreViewer(player, false);

        int slot = player.getInventory().getHeldItemSlot();
        ItemStack previous = player.getInventory().getItem(slot);
        ItemStack stored = previous == null ? null : previous.clone();

        World world = player.getWorld();
        MapView view = Bukkit.createMap(world);
        for (MapRenderer renderer : new ArrayList<>(view.getRenderers())) {
            view.removeRenderer(renderer);
        }
        view.addRenderer(new StaticImageRenderer(image));

        ItemStack mapItem = new ItemStack(Material.FILLED_MAP);
        MapMeta meta = (MapMeta) mapItem.getItemMeta();
        meta.setMapView(view);
        meta.setDisplayName("§ePerfect SMP Image");
        mapItem.setItemMeta(meta);

        viewerSessions.put(player.getUniqueId(), new ViewerSession(slot, stored, id));
        player.getInventory().setItem(slot, mapItem);
        player.sendMap(view);
        player.sendMessage("§ePerfect SMP Images §8• §7Image opened. Use §f/closeimage §7to close it.");
    }

    private void restoreViewer(Player player, boolean message) {
        ViewerSession session = viewerSessions.remove(player.getUniqueId());
        if (session == null) {
            if (message) player.sendMessage("§7No image viewer is open.");
            return;
        }

        player.getInventory().setItem(session.slot(), session.previousItem());
        if (message) player.sendMessage("§7Image viewer closed.");
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        restoreViewer(event.getPlayer(), false);
    }

    @EventHandler
    public void onHeld(PlayerItemHeldEvent event) {
        if (viewerSessions.containsKey(event.getPlayer().getUniqueId())) {
            event.setCancelled(true);
        }
    }

    @EventHandler
    public void onDrop(PlayerDropItemEvent event) {
        if (viewerSessions.containsKey(event.getPlayer().getUniqueId())) {
            event.setCancelled(true);
        }
    }

    @EventHandler
    public void onSwap(PlayerSwapHandItemsEvent event) {
        if (viewerSessions.containsKey(event.getPlayer().getUniqueId())) {
            event.setCancelled(true);
        }
    }

    @EventHandler
    public void onInventoryClick(InventoryClickEvent event) {
        HumanEntity who = event.getWhoClicked();
        if (who instanceof Player player && viewerSessions.containsKey(player.getUniqueId())) {
            event.setCancelled(true);
        }
    }

    @EventHandler
    public void onInventoryDrag(InventoryDragEvent event) {
        HumanEntity who = event.getWhoClicked();
        if (who instanceof Player player && viewerSessions.containsKey(player.getUniqueId())) {
            event.setCancelled(true);
        }
    }

    private String extractImageId(String input) {
        if (input == null) return null;
        String value = input.trim();
        if (SAFE_ID.matcher(value).matches()) return value;

        try {
            URI uri = new URI(value);
            if (uri.getScheme() == null || uri.getHost() == null) return null;
            if (!uri.getScheme().equalsIgnoreCase("https") && !uri.getScheme().equalsIgnoreCase("http")) return null;
            if (!hostAllowed(uri.getHost())) return null;

            Matcher matcher = PATH_ID.matcher(uri.getPath());
            if (matcher.find()) return matcher.group(1);

            String query = uri.getRawQuery();
            if (query != null) {
                for (String pair : query.split("&")) {
                    int split = pair.indexOf('=');
                    if (split <= 0) continue;
                    String key = pair.substring(0, split);
                    String candidate = pair.substring(split + 1);
                    if ((key.equals("image") || key.equals("id")) && SAFE_ID.matcher(candidate).matches()) return candidate;
                }
            }
        } catch (URISyntaxException ignored) {
        }
        return null;
    }

    private boolean hostAllowed(String host) {
        if (host == null || allowedHost == null || allowedHost.isBlank()) return false;
        return host.equalsIgnoreCase(allowedHost);
    }

    private String rawUrl(String id) {
        return websiteUrl + "/raw/" + id;
    }

    private void tellraw(Player player, String json) {
        Bukkit.dispatchCommand(Bukkit.getConsoleSender(), "tellraw " + player.getName() + " " + json);
    }

    private static String trimSlash(String value) {
        String result = value == null ? "" : value.trim();
        while (result.endsWith("/")) result = result.substring(0, result.length() - 1);
        return result;
    }

    private static String jsonEscape(String text) {
        if (text == null) return "";
        StringBuilder builder = new StringBuilder(text.length() + 16);
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '\\' -> builder.append("\\\\");
                case '"' -> builder.append("\\\"");
                case '\n' -> builder.append("\\n");
                case '\r' -> builder.append("\\r");
                case '\t' -> builder.append("\\t");
                default -> {
                    if (c < 0x20) builder.append(String.format("\\u%04x", (int) c));
                    else builder.append(c);
                }
            }
        }
        return builder.toString();
    }

    private record ViewerSession(int slot, ItemStack previousItem, String imageId) {}

    private static final class StaticImageRenderer extends MapRenderer {
        private final BufferedImage image;
        private boolean rendered;

        private StaticImageRenderer(BufferedImage image) {
            this.image = image;
        }

        @Override
        public void render(MapView map, MapCanvas canvas, Player player) {
            if (rendered) return;
            canvas.drawImage(0, 0, image);
            rendered = true;
        }
    }
}
