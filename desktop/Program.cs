using System.Drawing;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ChessReview;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(args.Contains("--devtools")));
    }
}

internal sealed class MainForm : Form
{
    private const string VirtualHost = "chessreview.local";

    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly bool _devtools;
    private FormBorderStyle _prevStyle;
    private FormWindowState _prevState;
    private bool _fullscreen;

    public MainForm(bool devtools)
    {
        _devtools = devtools;
        Text = "Chess Review";
        // не вылезаем за рабочую область экрана (ноутбуки 1366x768 и т.п.)
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
        int width = Math.Min(1260, Math.Max(area.Width - 40, 640));
        int height = Math.Min(900, Math.Max(area.Height - 40, 480));
        ClientSize = new Size(width, height);
        MinimumSize = new Size(Math.Min(860, width), Math.Min(640, height));
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(38, 36, 33);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { /* ignore */ }

        _web.DefaultBackgroundColor = Color.FromArgb(38, 36, 33);
        Controls.Add(_web);

        Load += async (_, _) => await InitializeAsync();
        KeyPreview = true;
        KeyDown += OnKeyDown;
    }

    private async Task InitializeAsync()
    {
        string webRoot;
        try
        {
            webRoot = WebBundle.EnsureExtracted();
        }
        catch (Exception ex)
        {
            Fail("Не удалось подготовить файлы приложения.\n\n" + ex.Message);
            return;
        }

        try
        {
            var userData = Path.Combine(WebBundle.DataDir, "userdata");
            var env = await CoreWebView2Environment.CreateAsync(null, userData);
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex)
        {
            Fail(
                "Не удалось запустить компонент WebView2.\n\n" +
                "Обычно он уже входит в Windows 10/11. Если нет — установите «Microsoft Edge WebView2 Runtime» " +
                "с сайта developer.microsoft.com/microsoft-edge/webview2.\n\n" + ex.Message);
            return;
        }

        var core = _web.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDevToolsEnabled = _devtools;
        core.Settings.IsZoomControlEnabled = true;
        core.Settings.IsSwipeNavigationEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.Settings.IsStatusBarEnabled = false;

        core.SetVirtualHostNameToFolderMapping(
            VirtualHost,
            webRoot,
            CoreWebView2HostResourceAccessKind.DenyCors);

        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            var url = e.Uri;
            if (url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true }); }
                catch { /* ignore */ }
            }
        };

        core.NavigationCompleted += (_, e) =>
        {
            if (!e.IsSuccess)
                MessageBox.Show(this, "Не удалось открыть интерфейс приложения.\n" + e.WebErrorStatus,
                    "Chess Review", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        };

        core.Navigate($"https://{VirtualHost}/index.html");
    }

    private void OnKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.KeyCode == Keys.F11)
        {
            ToggleFullscreen();
            e.Handled = true;
        }
        else if (e.Control && e.Shift && e.KeyCode == Keys.I && _devtools)
        {
            _web.CoreWebView2?.OpenDevToolsWindow();
            e.Handled = true;
        }
    }

    private void ToggleFullscreen()
    {
        if (!_fullscreen)
        {
            _prevStyle = FormBorderStyle;
            _prevState = WindowState;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Normal;
            WindowState = FormWindowState.Maximized;
            _fullscreen = true;
        }
        else
        {
            FormBorderStyle = _prevStyle;
            WindowState = _prevState;
            _fullscreen = false;
        }
    }

    private void Fail(string message)
    {
        MessageBox.Show(this, message, "Chess Review", MessageBoxButtons.OK, MessageBoxIcon.Error);
        Close();
    }
}

internal static class WebBundle
{
    public static string DataDir { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "ChessReview");

    /// <summary>Распаковывает встроенный web.zip в %LOCALAPPDATA%\ChessReview\web-&lt;hash&gt;.</summary>
    public static string EnsureExtracted()
    {
        var asm = Assembly.GetExecutingAssembly();
        var resource = asm.GetManifestResourceNames()
            .FirstOrDefault(n => n.EndsWith("web.zip", StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException("В сборке отсутствует web.zip");

        using var stream = asm.GetManifestResourceStream(resource)
            ?? throw new InvalidOperationException("Не удалось прочитать web.zip");
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        var bytes = ms.ToArray();

        var hash = Convert.ToHexString(SHA256.HashData(bytes))[..16].ToLowerInvariant();
        var dir = Path.Combine(DataDir, "web-" + hash);
        var marker = Path.Combine(dir, ".ready");

        if (!File.Exists(marker))
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
            Directory.CreateDirectory(dir);
            using (var zip = new ZipArchive(new MemoryStream(bytes), ZipArchiveMode.Read))
                zip.ExtractToDirectory(dir);
            File.WriteAllText(marker, hash);

            foreach (var old in Directory.GetDirectories(DataDir, "web-*"))
            {
                if (string.Equals(old, dir, StringComparison.OrdinalIgnoreCase)) continue;
                try { Directory.Delete(old, true); } catch { /* занято — не страшно */ }
            }
        }

        return dir;
    }
}
