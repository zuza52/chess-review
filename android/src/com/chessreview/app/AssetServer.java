package com.chessreview.app;

import android.content.res.AssetManager;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;

/**
 * Минимальный HTTP-сервер, который раздаёт assets приложения на 127.0.0.1.
 * Нужен, чтобы WebView получил http-origin (worker + wasm + service worker).
 */
final class AssetServer implements Runnable {

    private final AssetManager assets;
    private ServerSocket socket;
    private volatile boolean running = true;

    AssetServer(AssetManager assets) {
        this.assets = assets;
    }

    int start() throws IOException {
        socket = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        Thread thread = new Thread(this, "chess-assets");
        thread.setDaemon(true);
        thread.start();
        return socket.getLocalPort();
    }

    void stop() {
        running = false;
        try {
            if (socket != null) socket.close();
        } catch (IOException ignored) {
        }
    }

    @Override
    public void run() {
        while (running) {
            Socket client = null;
            try {
                client = socket.accept();
                client.setSoTimeout(20000);
                handle(client);
            } catch (IOException e) {
                if (!running) break;
            } finally {
                if (client != null) {
                    try {
                        client.close();
                    } catch (IOException ignored) {
                    }
                }
            }
        }
    }

    private void handle(Socket client) throws IOException {
        InputStream in = client.getInputStream();
        String requestLine = readLine(in);
        if (requestLine == null) return;

        String path = "/";
        String[] parts = requestLine.split(" ");
        if (parts.length >= 2) path = parts[1];

        // дочитываем заголовки
        int guard = 0;
        String header;
        while ((header = readLine(in)) != null && header.length() > 0 && guard++ < 200) {
            // ничего не нужно
        }

        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        int hash = path.indexOf('#');
        if (hash >= 0) path = path.substring(0, hash);
        if (path.isEmpty() || path.equals("/")) path = "/index.html";
        if (path.startsWith("/")) path = path.substring(1);
        try {
            path = URLDecoder.decode(path, "UTF-8");
        } catch (Exception ignored) {
        }
        if (path.contains("..")) {
            writeStatus(client, 403, "Forbidden");
            return;
        }

        byte[] body;
        try {
            InputStream asset = assets.open(path);
            body = readAll(asset);
            asset.close();
        } catch (IOException e) {
            writeStatus(client, 404, "Not Found");
            return;
        }

        OutputStream out = new BufferedOutputStream(client.getOutputStream());
        String head = "HTTP/1.1 200 OK\r\n"
                + "Content-Type: " + mime(path) + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes("UTF-8"));
        out.write(body);
        out.flush();
    }

    private void writeStatus(Socket client, int code, String text) throws IOException {
        OutputStream out = client.getOutputStream();
        String body = text;
        String head = "HTTP/1.1 " + code + " " + text + "\r\n"
                + "Content-Type: text/plain; charset=utf-8\r\n"
                + "Content-Length: " + body.getBytes("UTF-8").length + "\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes("UTF-8"));
        out.write(body.getBytes("UTF-8"));
        out.flush();
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(128);
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') buf.write(c);
            if (buf.size() > 8192) break;
        }
        if (c == -1 && buf.size() == 0) return null;
        return new String(buf.toByteArray(), "UTF-8");
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(65536);
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private static String mime(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html; charset=utf-8";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".json")) return "application/json; charset=utf-8";
        if (p.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".pgn") || p.endsWith(".txt")) return "text/plain; charset=utf-8";
        return "application/octet-stream";
    }
}
