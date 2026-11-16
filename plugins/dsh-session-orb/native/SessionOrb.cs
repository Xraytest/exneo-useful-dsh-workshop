// dsh-session-orb native helper.
//
// A separate process from the DSH desktop app on purpose: the orb has to outlive
// the window, and "always on top" has to be a real extended window style rather
// than a stacking hint inside a page. This file draws and hit-tests only; every
// decision (what finished, when to hide the bubble, what to persist) belongs to
// the Host plugin, which talks to us over 127.0.0.1 with a per-run token.
//
// Deliberately ASCII-only and word-free: every user-visible string arrives in the
// state payload. That keeps this file free of encoding hazards and keeps the
// language switch on the Host side.
//
// Build: csc /target:winexe /platform:anycpu /r:System.Windows.Forms.dll ...
//        (host/native.js owns the exact flags and the output cache.)
//
// Modes:
//   SessionOrb.exe --origin=http://127.0.0.1:PORT --token=... --parent=PID [--lang=zh]
//   SessionOrb.exe --probe [--out=C:\path\probe.json]

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using FormsTimer = System.Windows.Forms.Timer;

namespace DshSessionOrb
{
    internal static class Win32
    {
        public const int GWL_EXSTYLE = -20;
        public const int GWL_STYLE = -16;
        public const int WS_EX_TOPMOST = 0x00000008;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int WS_EX_LAYERED = 0x00080000;
        public const int WS_EX_NOACTIVATE = 0x08000000;
        public const int WS_EX_APPWINDOW = 0x00040000;

        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOZORDER = 0x0004;
        public const uint SWP_NOACTIVATE = 0x0010;
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public static readonly IntPtr HWND_TOP = new IntPtr(0);

        public const byte AC_SRC_OVER = 0x00;
        public const byte AC_SRC_ALPHA = 0x01;
        public const int ULW_ALPHA = 0x00000002;

        public const int WM_CLOSE = 0x0010;
        public const int WM_SYSCOMMAND = 0x0112;
        public const int SC_RESTORE = 0xF120;
        public const uint SEM_FAILCRITICALERRORS = 0x0001;
        public const uint SEM_NOGPFAULTERRORBOX = 0x0002;
        public const uint SEM_NOOPENFILEERRORBOX = 0x8000;
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint SetErrorMode(uint mode);

        public const int SW_SHOWNORMAL = 1;
        public const int SW_SHOW = 5;
        public const int SW_RESTORE = 9;

        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const int MDT_EFFECTIVE_DPI = 0;

        public const uint GW_HWNDPREV = 3;
        public const int DWMWA_CLOAKED = 14;

        [StructLayout(LayoutKind.Sequential)]
        public struct BLENDFUNCTION
        {
            public byte BlendOp;
            public byte BlendFlags;
            public byte SourceConstantAlpha;
            public byte AlphaFormat;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
            public int Width { get { return this.Right - this.Left; } }
            public int Height { get { return this.Bottom - this.Top; } }
        }

        public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lparam);

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lparam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassNameW(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hwnd, int command);
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        public static extern bool BringWindowToTop(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint attach, uint attachTo, bool join);
        [DllImport("user32.dll")]
        public static extern int GetWindowLongW(IntPtr hwnd, int index);
        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")]
        public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
        [DllImport("shell32.dll")]
        public static extern int SHQueryUserNotificationState(out int state);
        [DllImport("user32.dll")]
        public static extern bool PostMessageW(IntPtr hwnd, int message, IntPtr wparam, IntPtr lparam);
        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out Point point);
        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromPoint(Point point, uint flags);
        [DllImport("user32.dll")]
        public static extern uint GetDpiForWindow(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();
        [DllImport("shcore.dll")]
        public static extern int SetProcessDpiAwareness(int value);
        [DllImport("shcore.dll")]
        public static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);

        [DllImport("user32.dll")]
        public static extern IntPtr GetDC(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")]
        public static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")]
        public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
        [DllImport("gdi32.dll")]
        public static extern bool DeleteObject(IntPtr obj);
        [DllImport("user32.dll")]
        public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr dstDc, ref Point dst, ref Size size, IntPtr srcDc, ref Point src, int key, ref BLENDFUNCTION blend, int flags);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr ShellExecuteW(IntPtr hwnd, string operation, string file, string parameters, string directory, int show);

        [DllImport("kernel32.dll")]
        public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")]
        public static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder buffer, ref int size);
        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();
    }

    internal static class Dpi
    {
        public static string Mode = "unaware";

        public static void Enable()
        {
            // PerMonitorV2 first: it is the only mode where a window moved to a
            // display with a different scale factor is told about it.
            try
            {
                if (Win32.SetProcessDpiAwarenessContext(new IntPtr(-4)))
                {
                    Mode = "pmv2";
                    return;
                }
            }
            catch
            {
            }
            try
            {
                if (Win32.SetProcessDpiAwareness(2) == 0)
                {
                    Mode = "per-monitor";
                    return;
                }
            }
            catch
            {
            }
            try
            {
                if (Win32.SetProcessDPIAware()) Mode = "system";
            }
            catch
            {
            }
        }

        public static float ScaleOf(IntPtr hwnd)
        {
            try
            {
                uint dpi = Win32.GetDpiForWindow(hwnd);
                if (dpi >= 72 && dpi <= 480) return dpi / 96f;
            }
            catch
            {
            }
            try
            {
                IntPtr monitor = Win32.MonitorFromPoint(new Point(0, 0), 2u);
                uint dx;
                uint dy;
                if (Win32.GetDpiForMonitor(monitor, Win32.MDT_EFFECTIVE_DPI, out dx, out dy) == 0 && dx >= 72)
                {
                    return dx / 96f;
                }
            }
            catch
            {
            }
            return 1f;
        }
    }

    /// <summary>Thin, forgiving accessors over JavaScriptSerializer output.</summary>
    internal static class Json
    {
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();

        public static object Parse(string text)
        {
            return Serializer.DeserializeObject(text);
        }

        public static string ToJson(object value)
        {
            return Serializer.Serialize(value);
        }

        public static Dictionary<string, object> Object(object value)
        {
            return value as Dictionary<string, object>;
        }

        public static object Get(IDictionary<string, object> map, string key)
        {
            if (map == null) return null;
            object value;
            return map.TryGetValue(key, out value) ? value : null;
        }

        public static string Str(IDictionary<string, object> map, string key, string fallback)
        {
            object value = Get(map, key);
            if (value == null) return fallback;
            string text = value as string;
            return text == null ? fallback : text;
        }

        public static double Num(IDictionary<string, object> map, string key, double fallback)
        {
            object value = Get(map, key);
            if (value == null) return fallback;
            try
            {
                if (value is string) return double.Parse((string)value, CultureInfo.InvariantCulture);
                return Convert.ToDouble(value, CultureInfo.InvariantCulture);
            }
            catch
            {
                return fallback;
            }
        }

        public static int Int(IDictionary<string, object> map, string key, int fallback)
        {
            double value = Num(map, key, fallback);
            if (double.IsNaN(value) || double.IsInfinity(value)) return fallback;
            return (int)Math.Round(value);
        }

        public static bool Bool(IDictionary<string, object> map, string key, bool fallback)
        {
            object value = Get(map, key);
            if (value == null) return fallback;
            if (value is bool) return (bool)value;
            string text = value as string;
            if (text != null) return string.Equals(text, "true", StringComparison.OrdinalIgnoreCase);
            return fallback;
        }

        public static Dictionary<string, object> Rect(Rectangle value)
        {
            Dictionary<string, object> map = new Dictionary<string, object>();
            map["x"] = value.X;
            map["y"] = value.Y;
            map["w"] = value.Width;
            map["h"] = value.Height;
            return map;
        }

        public static Dictionary<string, object> RectOf(Win32.RECT value)
        {
            Dictionary<string, object> map = new Dictionary<string, object>();
            map["x"] = value.Left;
            map["y"] = value.Top;
            map["w"] = value.Width;
            map["h"] = value.Height;
            return map;
        }
    }

    internal sealed class OrbSettings
    {
        public double Fill = 0.30;
        public double Opacity = 0.88;
        public int Size = 56;
        public int Radius = 17;
        public double BubbleAlpha = 0.92;
        public int BubbleMs = 8000;
        public bool Pulse = true;
        public bool Badge = true;
        /// <summary>Whether the ball is on screen. The process keeps running while
        /// hidden so re-showing it costs nothing and no state is lost.</summary>
        public bool Visible = true;

        public static OrbSettings Parse(IDictionary<string, object> map)
        {
            OrbSettings s = new OrbSettings();
            if (map == null) return s;
            s.Fill = Clamp(Json.Num(map, "fill", s.Fill), 0.04, 0.96);
            s.Opacity = Clamp(Json.Num(map, "opacity", s.Opacity), 0.10, 1.0);
            s.Size = Math.Max(16, Math.Min(128, Json.Int(map, "size", s.Size)));
            s.Radius = Math.Max(0, Math.Min(Math.Min(64, s.Size / 2), Json.Int(map, "radius", s.Radius)));
            s.BubbleAlpha = Clamp(Json.Num(map, "bubbleAlpha", s.BubbleAlpha), 0.3, 1.0);
            s.BubbleMs = Math.Max(0, Math.Min(600000, Json.Int(map, "bubbleMs", s.BubbleMs)));
            s.Pulse = Json.Bool(map, "pulse", s.Pulse);
            s.Badge = Json.Bool(map, "badge", s.Badge);
            s.Visible = Json.Bool(map, "visible", s.Visible);
            return s;
        }

        public bool SameAs(OrbSettings other)
        {
            if (other == null) return false;
            return Math.Abs(this.Fill - other.Fill) < 0.002
                && Math.Abs(this.Opacity - other.Opacity) < 0.002
                && this.Size == other.Size
                && this.Radius == other.Radius
                && Math.Abs(this.BubbleAlpha - other.BubbleAlpha) < 0.002
                && this.Pulse == other.Pulse
                && this.Badge == other.Badge
                && this.Visible == other.Visible;
        }

        private static double Clamp(double value, double low, double high)
        {
            if (value < low) return low;
            if (value > high) return high;
            return value;
        }
    }

    internal sealed class OrbNotice
    {
        public string SessionId = "";
        public string Title = "";
        public int More;

        public static OrbNotice Parse(object value)
        {
            Dictionary<string, object> map = value as Dictionary<string, object>;
            if (map == null) return null;
            OrbNotice notice = new OrbNotice();
            notice.SessionId = Json.Str(map, "sessionId", "");
            notice.Title = Json.Str(map, "title", "");
            notice.More = Math.Max(0, Json.Int(map, "more", 0));
            return notice;
        }

        public bool SameAs(OrbNotice other)
        {
            if (other == null) return false;
            return this.SessionId == other.SessionId && this.Title == other.Title && this.More == other.More;
        }
    }

    internal sealed class OrbState
    {
        public OrbSettings Settings = new OrbSettings();
        public OrbNotice Notice;
        public int Running;
        public Point Position = Point.Empty;
        public bool HasPosition;
        public string Lang = "zh";
        public string Degraded = "";
        public int Seq;

        public static OrbState Parse(IDictionary<string, object> map)
        {
            OrbState state = new OrbState();
            if (map == null) return state;
            state.Settings = OrbSettings.Parse(Json.Object(Json.Get(map, "settings")));
            state.Notice = OrbNotice.Parse(Json.Get(map, "notice"));
            state.Running = Math.Max(0, Json.Int(map, "running", 0));
            state.Seq = Json.Int(map, "seq", 0);
            state.Lang = Json.Str(map, "lang", "zh");
            state.Degraded = Json.Str(map, "degraded", "");
            Dictionary<string, object> position = Json.Object(Json.Get(map, "position"));
            if (position != null)
            {
                state.Position = new Point(Json.Int(position, "x", 0), Json.Int(position, "y", 0));
                state.HasPosition = true;
            }
            return state;
        }
    }

    internal static class Ink
    {
        public static readonly Color BadgeColor = Color.FromArgb(255, 95, 87);
        public static readonly Color BubbleBg = Color.FromArgb(8, 9, 12);
        public static readonly Color TextPrimary = Color.FromArgb(247, 248, 250);
        public static readonly Color LiveDot = Color.FromArgb(74, 222, 128);

        public static GraphicsPath RoundRect(RectangleF rect, float radius)
        {
            GraphicsPath path = new GraphicsPath();
            float limit = Math.Min(rect.Width, rect.Height) / 2f;
            if (radius > limit) radius = limit;
            if (radius <= 0.2f)
            {
                path.AddRectangle(rect);
                path.CloseFigure();
                return path;
            }
            float d = radius * 2f;
            path.AddArc(rect.X, rect.Y, d, d, 180f, 90f);
            path.AddArc(rect.Right - d, rect.Y, d, d, 270f, 90f);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0f, 90f);
            path.AddArc(rect.X, rect.Bottom - d, d, d, 90f, 90f);
            path.CloseFigure();
            return path;
        }

        public static Bitmap Canvas(int width, int height)
        {
            if (width < 1) width = 1;
            if (height < 1) height = 1;
            return new Bitmap(width, height, PixelFormat.Format32bppPArgb);
        }

        /// <summary>Cleared, anti-aliased surface. Cleartype is deliberately not
        /// used: it writes colour into the alpha channel.</summary>
        public static Graphics Begin(Bitmap bitmap)
        {
            Graphics g = Graphics.FromImage(bitmap);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.CompositingQuality = CompositingQuality.GammaCorrected;
            g.CompositingMode = CompositingMode.SourceOver;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.Clear(Color.Transparent);
            return g;
        }

        /// <summary>
        /// Blurred rounded-rect shadow. Drawing at quarter scale and letting the
        /// upscale do the blurring is cheaper and smoother than sampling a
        /// Gaussian kernel by hand, and it stays correct at any DPI.
        /// </summary>
        public static Bitmap Shadow(int width, int height, RectangleF rect, float radius, float blur, float offsetY, int alpha)
        {
            Bitmap canvas = Canvas(width, height);
            int blurPx = Math.Max(2, (int)Math.Round(blur));
            int sw = Math.Max(2, (width + blurPx * 2) / 4);
            int sh = Math.Max(2, (height + blurPx * 2) / 4);
            using (Bitmap small = Canvas(sw, sh))
            {
                using (Graphics sg = Graphics.FromImage(small))
                {
                    sg.SmoothingMode = SmoothingMode.AntiAlias;
                    sg.Clear(Color.Transparent);
                    // The small bitmap covers the region [-blurPx, size+blurPx] of the
                    // target, so a target-space point maps to (p + blurPx) / 4.
                    RectangleF inner = new RectangleF(
                        (rect.X + blurPx) / 4f,
                        (rect.Y + blurPx + offsetY) / 4f,
                        rect.Width / 4f,
                        rect.Height / 4f);
                    using (GraphicsPath path = RoundRect(inner, Math.Max(0.5f, radius / 4f)))
                    using (SolidBrush brush = new SolidBrush(Color.FromArgb(alpha, 0, 0, 0)))
                    {
                        sg.FillPath(brush, path);
                    }
                }
                using (Graphics g = Begin(canvas))
                {
                    Rectangle destination = new Rectangle(-blurPx, -blurPx, width + blurPx * 2, height + blurPx * 2);
                    g.DrawImage(small, destination, 0, 0, sw, sh, GraphicsUnit.Pixel);
                }
            }
            return canvas;
        }

        public static FontFamily Family(string preferred)
        {
            try
            {
                return new FontFamily(preferred);
            }
            catch
            {
            }
            return FontFamily.GenericSansSerif;
        }

        public static bool NeedsCjk(string text)
        {
            if (string.IsNullOrEmpty(text)) return false;
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c >= 0x2E80 && c <= 0x9FFF) return true;
                if (c >= 0xAC00 && c <= 0xD7AF) return true;
                if (c >= 0xF900 && c <= 0xFAFF) return true;
                if (c >= 0xFF00 && c <= 0xFFEF) return true;
            }
            return false;
        }

        /// <summary>Greedy wrap with a line clamp and an honest ellipsis.</summary>
        public static List<string> Wrap(Graphics g, string text, Font font, float maxWidth, int maxLines)
        {
            List<string> lines = new List<string>();
            if (string.IsNullOrEmpty(text)) return lines;
            if (maxWidth < 8f) maxWidth = 8f;
            text = text.Replace("\r", " ").Replace("\n", " ").Trim();
            if (text.Length == 0) return lines;
            using (StringFormat format = Typographic())
            {
                StringBuilder current = new StringBuilder();
                int index = 0;
                while (index < text.Length)
                {
                    current.Append(text[index]);
                    string candidate = current.ToString();
                    if (Measure(g, candidate, font, format) <= maxWidth)
                    {
                        index++;
                        continue;
                    }
                    string line = candidate;
                    int consumed;
                    int space = line.LastIndexOf(' ');
                    if (space > 0 && space >= line.Length - 2)
                    {
                        line = line.Substring(0, space);
                        consumed = line.Length + 1;
                    }
                    else
                    {
                        line = line.Substring(0, Math.Max(1, line.Length - 1));
                        consumed = line.Length;
                    }
                    lines.Add(line.TrimEnd());
                    current.Length = 0;
                    index += consumed;
                    if (lines.Count == maxLines)
                    {
                        if (index < text.Length)
                        {
                            lines[lines.Count - 1] = Clamp(g, lines[lines.Count - 1], font, maxWidth, format);
                        }
                        return lines;
                    }
                }
                if (current.Length > 0) lines.Add(current.ToString().TrimEnd());
            }
            return lines;
        }

        private static string Clamp(Graphics g, string line, Font font, float maxWidth, StringFormat format)
        {
            string result = line.TrimEnd() + "\u2026";
            while (result.Length > 1)
            {
                if (Measure(g, result, font, format) <= maxWidth) return result;
                result = result.Substring(0, result.Length - 2) + "\u2026";
            }
            return "\u2026";
        }

        private static float Measure(Graphics g, string text, Font font, StringFormat format)
        {
            return g.MeasureString(text, font, new PointF(0f, 0f), format).Width;
        }

        public static void Text(Graphics g, string text, Font font, Color color, PointF origin, StringFormat format)
        {
            if (string.IsNullOrEmpty(text)) return;
            using (SolidBrush brush = new SolidBrush(color))
            {
                g.DrawString(text, font, brush, origin, format);
            }
        }

        public static StringFormat Typographic()
        {
            StringFormat format = (StringFormat)StringFormat.GenericTypographic.Clone();
            format.FormatFlags |= StringFormatFlags.NoWrap;
            format.FormatFlags |= StringFormatFlags.NoClip;
            format.Trimming = StringTrimming.None;
            return format;
        }

        public static StringFormat Centered()
        {
            StringFormat format = (StringFormat)StringFormat.GenericTypographic.Clone();
            format.Alignment = StringAlignment.Center;
            format.LineAlignment = StringAlignment.Center;
            return format;
        }
    }

    internal abstract class LayeredWindow : Form
    {
        /// <summary>This process id, cached: the cover test compares every window
        /// above us against it twice a second.</summary>
        private static readonly int SelfPid = Process.GetCurrentProcess().Id;

        public bool CloseRequested;

        protected LayeredWindow()
        {
            this.FormBorderStyle = FormBorderStyle.None;
            this.ShowInTaskbar = false;
            this.StartPosition = FormStartPosition.Manual;
            this.AutoScaleMode = AutoScaleMode.None;
            this.MinimizeBox = false;
            this.MaximizeBox = false;
            this.ControlBox = false;
            this.Text = "DSH_SESSION_ORB";
            this.BackColor = Color.Black;
            this.TopMost = true;
            this.SetStyle(ControlStyles.UserPaint, true);
            this.SetStyle(ControlStyles.AllPaintingInWmPaint, true);
            this.SetStyle(ControlStyles.Opaque, true);
            // Never touch Form.Opacity: its setter calls SetLayeredWindowAttributes,
            // which evicts the UpdateLayeredWindow surface and blanks the window.
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= Win32.WS_EX_LAYERED;
                cp.ExStyle |= Win32.WS_EX_NOACTIVATE;
                cp.ExStyle |= Win32.WS_EX_TOPMOST;
                cp.ExStyle |= Win32.WS_EX_TOOLWINDOW;
                cp.ExStyle &= ~Win32.WS_EX_APPWINDOW;
                return cp;
            }
        }

        public bool TopMostPresent
        {
            get
            {
                if (!this.IsHandleCreated || this.IsDisposed) return false;
                return (Win32.GetWindowLongW(this.Handle, Win32.GWL_EXSTYLE) & Win32.WS_EX_TOPMOST) != 0;
            }
        }

        /// <summary>
        /// Puts this window at the front of the topmost band.
        ///
        /// Membership of that band is a style bit, but the order *inside* it is a
        /// plain z-order: every always-on-top app raised after us (a player, the
        /// tray flyout, a hardware panel, QQ's floating bar) ends up above this
        /// window while our bit stays exactly as it was. Re-asserting the bit
        /// therefore fixes nothing; only another SetWindowPos(HWND_TOPMOST) moves
        /// us back to the front, because that call re-inserts the window at the
        /// head of the band.
        /// </summary>
        public void AssertTopMost()
        {
            if (!this.IsHandleCreated || this.IsDisposed) return;
            Win32.SetWindowPos(this.Handle, Win32.HWND_TOPMOST, 0, 0, 0, 0,
                Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
        }

        /// <summary>
        /// Repair pass for the watchdog: checks the *z-order*, not just the style
        /// bit. Returns true when the window had to be raised, with a short note
        /// naming the window that was covering it.
        /// </summary>
        public bool EnsureOnTop(out string note)
        {
            note = null;
            if (!this.IsHandleCreated || this.IsDisposed || !this.Visible) return false;
            if (!this.TopMostPresent)
            {
                this.AssertTopMost();
                note = "restored the WS_EX_TOPMOST bit";
                return true;
            }
            // A fullscreen app or a presentation owns the screen: it is above every
            // normal window on purpose, and fighting it would only flicker.
            if (ScreenBusy()) return false;
            string cover = this.CoveringWindow();
            if (cover == null) return false;
            this.AssertTopMost();
            note = "raised above " + cover;
            return true;
        }

        /// <summary>
        /// Describes the first window above this one that actually hides part of
        /// it, or null when nothing does. Walks GW_HWNDPREV (the window directly
        /// above) and stops at the first non-topmost window: nothing above the
        /// band can cover a topmost window.
        /// </summary>
        public string CoveringWindow()
        {
            Rectangle mine = this.Bounds;
            IntPtr walk = Win32.GetWindow(this.Handle, Win32.GW_HWNDPREV);
            int guard = 0;
            while (walk != IntPtr.Zero && guard++ < 96)
            {
                int ex = Win32.GetWindowLongW(walk, Win32.GWL_EXSTYLE);
                if ((ex & Win32.WS_EX_TOPMOST) == 0) break;
                if (this.CoversMe(walk, mine)) return DescribeWindow(walk);
                walk = Win32.GetWindow(walk, Win32.GW_HWNDPREV);
            }
            return null;
        }

        private bool CoversMe(IntPtr window, Rectangle mine)
        {
            if (!Win32.IsWindowVisible(window)) return false;
            // Cloaked windows (suspended UWP frames, ghost frames of a closed app)
            // are enumerable but invisible: they must never provoke a raise.
            int cloaked;
            if (Win32.DwmGetWindowAttribute(window, Win32.DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0) return false;
            uint pid;
            Win32.GetWindowThreadProcessId(window, out pid);
            // Our own card and menu live in this same process and are supposed to
            // sit above the ball; treating them as obstacles would make the two
            // windows fight for the same slot twice a second.
            if (pid == (uint)SelfPid) return false;
            Win32.RECT rect;
            if (!Win32.GetWindowRect(window, out rect)) return false;
            if (rect.Width <= 0 || rect.Height <= 0) return false;
            if (IsNeverObstacle(ClassOf(window))) return false;
            return mine.Left < rect.Right && rect.Left < mine.Right
                && mine.Top < rect.Bottom && rect.Top < mine.Bottom;
        }

        private static bool ScreenBusy()
        {
            int state;
            if (Win32.SHQueryUserNotificationState(out state) != 0) return false;
            // 2 busy, 3 D3D fullscreen, 4 presentation mode, 6 quiet time.
            return state == 2 || state == 3 || state == 4 || state == 6;
        }

        /// <summary>
        /// Topmost windows that must not push the ball around: desktop surfaces,
        /// transient tooltips and the tray flyout (none of them is "an app that
        /// covered the ball"), plus the shell's own full-screen pickers - Start,
        /// search, action center, Alt-Tab, Task View. A translucent ball floating
        /// over the Start menu reads as a bug, not as "always on top"; when the
        /// picker closes the ball is visible again with no repair needed.
        /// </summary>
        private static bool IsNeverObstacle(string cls)
        {
            if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_Desktop") return true;
            if (cls == "tooltips_class32" || cls == "NotifyIconOverflowWindow") return true;
            if (cls == "TaskListThumbnailWnd" || cls == "ForegroundStaging") return true;
            if (cls == "TaskSwitcherWnd" || cls == "MultitaskingViewFrame") return true;
            if (cls.StartsWith("Windows.UI.Core", StringComparison.Ordinal)) return true;
            if (cls.StartsWith("XamlExplorerHostIsland", StringComparison.Ordinal)) return true;
            if (cls.StartsWith("Windows.Internal.Shell", StringComparison.Ordinal)) return true;
            return false;
        }

        private static string ClassOf(IntPtr window)
        {
            StringBuilder cls = new StringBuilder(256);
            Win32.GetClassNameW(window, cls, cls.Capacity);
            return cls.ToString();
        }

        private static string DescribeWindow(IntPtr window)
        {
            uint pid;
            Win32.GetWindowThreadProcessId(window, out pid);
            return ClassOf(window) + " pid=" + pid.ToString(CultureInfo.InvariantCulture);
        }

        /// <summary>Raise within the topmost band.</summary>
        public void Raise()
        {
            if (!this.IsHandleCreated || this.IsDisposed) return;
            Win32.SetWindowPos(this.Handle, Win32.HWND_TOP, 0, 0, 0, 0,
                Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
        }

        /// <summary>Publishes one premultiplied bitmap as this window's surface.</summary>
        public void Present(Bitmap bitmap, byte alpha)
        {
            if (bitmap == null || !this.IsHandleCreated || this.IsDisposed) return;
            IntPtr screenDc = Win32.GetDC(IntPtr.Zero);
            IntPtr memoryDc = Win32.CreateCompatibleDC(screenDc);
            IntPtr hbitmap = IntPtr.Zero;
            IntPtr previous = IntPtr.Zero;
            try
            {
                hbitmap = bitmap.GetHbitmap(Color.FromArgb(0));
                previous = Win32.SelectObject(memoryDc, hbitmap);
                Point destination = new Point(this.Left, this.Top);
                Size size = new Size(bitmap.Width, bitmap.Height);
                Point source = new Point(0, 0);
                Win32.BLENDFUNCTION blend = new Win32.BLENDFUNCTION();
                blend.BlendOp = Win32.AC_SRC_OVER;
                blend.BlendFlags = 0;
                blend.SourceConstantAlpha = alpha;
                blend.AlphaFormat = Win32.AC_SRC_ALPHA;
                Win32.UpdateLayeredWindow(this.Handle, screenDc, ref destination, ref size, memoryDc, ref source, 0, ref blend, Win32.ULW_ALPHA);
            }
            finally
            {
                if (hbitmap != IntPtr.Zero)
                {
                    Win32.SelectObject(memoryDc, previous);
                    Win32.DeleteObject(hbitmap);
                }
                Win32.DeleteDC(memoryDc);
                Win32.ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        public void MoveTo(int x, int y)
        {
            if (this.Left == x && this.Top == y) return;
            this.Left = x;
            this.Top = y;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            // The layered surface owns every pixel; GDI painting is disabled.
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Win32.WM_CLOSE)
            {
                m.Result = IntPtr.Zero;
                this.CloseRequested = true;
                this.OnCloseRequested();
                return;
            }
            base.WndProc(ref m);
        }

        protected virtual void OnCloseRequested()
        {
        }
    }

    internal sealed class OrbWindow : LayeredWindow
    {
        private OrbSettings settings = new OrbSettings();
        private OrbNotice notice;
        private int running;
        private float scale = 1f;
        private int ballSize;
        private int padding;
        private int total;
        private Bitmap shadowNormal;
        private Bitmap shadowHover;
        private Bitmap baseSurface;
        private Bitmap frameSurface;
        private Font badgeFont;
        private bool hover;
        private bool dragging;
        private bool pressed;
        private Point pressCursor;
        private Point pressWindow;
        private string badgeText = "";
        private float pulseSeconds;
        private bool dirty = true;

        public event EventHandler Moved;

        public Rectangle BallRect
        {
            get { return new Rectangle(this.Left + this.padding, this.Top + this.padding, this.ballSize, this.ballSize); }
        }

        public int Pad
        {
            get { return this.padding; }
        }

        public float DpiScale
        {
            get { return this.scale; }
        }

        public bool IsDragging
        {
            get { return this.dragging; }
        }

        /// <summary>True once a bitmap exists AND a handle can publish it.</summary>
        public bool HasSurface
        {
            get { return this.baseSurface != null && this.IsHandleCreated; }
        }

        public void Configure(OrbSettings next, OrbNotice current, int runningCount)
        {
            bool changed = next == null || !next.SameAs(this.settings);
            if (next != null) this.settings = next;
            this.notice = current;
            this.running = runningCount;
            string badge = "";
            if (this.settings.Badge && current != null)
            {
                int count = current.More + 1;
                badge = count > 99 ? "99" : count.ToString(CultureInfo.InvariantCulture);
            }
            if (badge != this.badgeText)
            {
                this.badgeText = badge;
                changed = true;
            }
            if (this.baseSurface == null || changed) this.Rebuild();
            else this.dirty = true;
        }

        public void SetScale(float value)
        {
            if (Math.Abs(value - this.scale) < 0.01f) return;
            this.scale = value;
            this.Rebuild();
        }

        private void Rebuild()
        {
            this.ballSize = Math.Max(8, (int)Math.Round(this.settings.Size * this.scale));
            this.padding = (int)Math.Ceiling(this.ballSize * 0.30) + (int)Math.Round(14 * this.scale);
            this.total = this.ballSize + this.padding * 2;
            int blur = (int)Math.Round(11f * this.scale) + 2;
            RectangleF ball = new RectangleF(this.padding, this.padding, this.ballSize, this.ballSize);
            float radius = Math.Max(0f, this.settings.Radius * this.scale);

            Dispose(this.shadowNormal);
            Dispose(this.shadowHover);
            this.shadowNormal = Ink.Shadow(this.total, this.total, ball, radius, blur, 8f * this.scale, 107);
            this.shadowHover = Ink.Shadow(this.total, this.total, ball, radius + 2f, blur + 2f, 10f * this.scale, 128);

            if (this.badgeFont != null)
            {
                this.badgeFont.Dispose();
                this.badgeFont = null;
            }
            if (this.badgeText.Length > 0)
            {
                this.badgeFont = new Font(Ink.Family("Segoe UI"), 10f * this.scale, FontStyle.Bold, GraphicsUnit.Pixel);
            }

            this.sizeChangedPending = true;
            this.RenderBase();
        }

        private bool sizeChangedPending;

        private void RenderBase()
        {
            Dispose(this.baseSurface);
            this.baseSurface = Ink.Canvas(this.total, this.total);
            using (Graphics g = Ink.Begin(this.baseSurface))
            {
                float radius = Math.Max(0f, this.settings.Radius * this.scale);
                RectangleF ball = new RectangleF(this.padding, this.padding, this.ballSize, this.ballSize);
                Bitmap shadow = this.hover || this.dragging ? this.shadowHover : this.shadowNormal;
                if (shadow != null) g.DrawImageUnscaled(shadow, 0, 0);

                float shrink = this.dragging ? 1.03f : 1f;
                RectangleF shape = ball;
                if (shrink != 1f)
                {
                    float cx = ball.X + ball.Width / 2f;
                    float cy = ball.Y + ball.Height / 2f;
                    shape = new RectangleF(cx - ball.Width * shrink / 2f, cy - ball.Height * shrink / 2f, ball.Width * shrink, ball.Height * shrink);
                }

                double opacity = this.settings.Opacity;
                if ((this.hover || this.dragging) && !this.dragging) opacity = Math.Min(1.0, opacity + 0.12);
                if (this.dragging) opacity = 1.0;
                double scaleFactor = shrink;

                using (GraphicsPath path = Ink.RoundRect(shape, (float)(radius * scaleFactor)))
                {
                    int fill = (int)Math.Round(this.settings.Fill * opacity * 255.0);
                    using (SolidBrush brush = new SolidBrush(Color.FromArgb(fill, 0, 0, 0)))
                    {
                        g.FillPath(brush, path);
                    }
                    int border = (int)Math.Round(0.17 * opacity * 255.0);
                    using (Pen pen = new Pen(Color.FromArgb(border, 255, 255, 255), Math.Max(1f, 1f * this.scale)))
                    {
                        g.DrawPath(pen, path);
                    }
                }

                // Top inner highlight: the 1px specular line that makes a dark
                // translucent ball read as glass instead of a hole.
                using (GraphicsPath clip = Ink.RoundRect(shape, (float)(radius * scaleFactor)))
                {
                    Region previous = g.Clip;
                    g.SetClip(clip, CombineMode.Replace);
                    int highlight = (int)Math.Round(0.14 * opacity * 255.0);
                    using (Pen pen = new Pen(Color.FromArgb(highlight, 255, 255, 255), Math.Max(1f, 1f * this.scale)))
                    {
                        g.DrawLine(pen, shape.Left + 1f, shape.Top + 0.5f, shape.Right - 1f, shape.Top + 0.5f);
                    }
                    g.Clip = previous;
                }

                float coreSize = this.ballSize * 0.214f;
                RectangleF core = new RectangleF(
                    ball.X + ball.Width / 2f - coreSize / 2f,
                    ball.Y + ball.Height / 2f - coreSize / 2f,
                    coreSize,
                    coreSize);
                RectangleF glow = RectangleF.Inflate(core, coreSize, coreSize);
                using (GraphicsPath glowPath = new GraphicsPath())
                {
                    glowPath.AddEllipse(glow);
                    using (PathGradientBrush brush = new PathGradientBrush(glowPath))
                    {
                        brush.CenterColor = Color.FromArgb((int)Math.Round(90 * opacity), 255, 255, 255);
                        brush.SurroundColors = new Color[] { Color.FromArgb(0, 255, 255, 255) };
                        g.FillEllipse(brush, glow);
                    }
                }
                using (SolidBrush brush = new SolidBrush(Color.FromArgb((int)Math.Round(235 * opacity), 255, 255, 255)))
                {
                    g.FillEllipse(brush, core);
                }

                if (this.badgeText.Length > 0 && this.badgeFont != null)
                {
                    float badgeHeight = 16f * this.scale;
                    using (StringFormat measureFormat = Ink.Typographic())
                    {
                        SizeF measured = g.MeasureString(this.badgeText, this.badgeFont, new PointF(0f, 0f), measureFormat);
                        float badgeWidth = Math.Max(badgeHeight, measured.Width + 8f * this.scale);
                        RectangleF badge = new RectangleF(
                            shape.Right - 5f * this.scale - badgeWidth,
                            shape.Top + 5f * this.scale,
                            badgeWidth,
                            badgeHeight);
                        using (GraphicsPath path = Ink.RoundRect(badge, badgeHeight / 2f))
                        using (SolidBrush brush = new SolidBrush(Color.FromArgb((int)Math.Round(opacity * 255.0), Ink.BadgeColor)))
                        {
                            g.FillPath(brush, path);
                        }
                        using (StringFormat centered = Ink.Centered())
                        using (SolidBrush brush = new SolidBrush(Color.FromArgb((int)Math.Round(opacity * 255.0), 255, 255, 255)))
                        {
                            g.DrawString(this.badgeText, this.badgeFont, brush, badge, centered);
                        }
                    }
                }
            }
            this.dirty = false;
            if (this.sizeChangedPending)
            {
                this.sizeChangedPending = false;
                if (this.Width != this.total || this.Height != this.total)
                {
                    this.Size = new Size(this.total, this.total);
                }
            }
        }

        /// <summary>Base surface plus the pulse ring, composed per animation frame.</summary>
        private Bitmap ComposeFrame()
        {
            if (this.baseSurface == null) return null;
            if (this.frameSurface == null || this.frameSurface.Width != this.total || this.frameSurface.Height != this.total)
            {
                Dispose(this.frameSurface);
                this.frameSurface = Ink.Canvas(this.total, this.total);
            }
            using (Graphics g = Ink.Begin(this.frameSurface))
            {
                g.DrawImageUnscaled(this.baseSurface, 0, 0);
                float radius = Math.Max(0f, this.settings.Radius * this.scale);
                RectangleF ball = new RectangleF(this.padding, this.padding, this.ballSize, this.ballSize);
                float phase = this.pulseSeconds % 2.6f;
                float t = phase / 2.6f;
                float eased = 1f - (float)Math.Pow(1f - t, 3);
                float grow = this.ballSize * 0.32f * eased;
                int alpha = (int)Math.Round(0.45f * (1f - t) * 255f);
                if (alpha > 1)
                {
                    RectangleF ring = RectangleF.Inflate(ball, grow, grow);
                    using (GraphicsPath path = Ink.RoundRect(ring, radius + grow))
                    using (Pen pen = new Pen(Color.FromArgb(alpha, 255, 255, 255), Math.Max(1f, 1f * this.scale)))
                    {
                        g.DrawPath(pen, path);
                    }
                }
            }
            return this.frameSurface;
        }

        /// <summary>Advance the ring by dt seconds and publish; no-op when idle.</summary>
        public void Animate(float dt)
        {
            if (this.baseSurface == null) return;
            this.pulseSeconds += dt;
            if (this.pulseSeconds > 26f) this.pulseSeconds = 0f;
            Present(ComposeFrame(), 255);
        }

        /// <summary>Publish at rest, only when something actually changed.</summary>
        public void PresentRest()
        {
            if (this.baseSurface == null) return;
            if (this.dirty) RenderBase();
            Present(this.baseSurface, 255);
        }

        public void Repaint()
        {
            this.dirty = true;
            PresentRest();
        }

        public void SetHover(bool value)
        {
            if (this.hover == value) return;
            this.hover = value;
            this.Repaint();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Right)
            {
                // Context menu. The menu takes the mouse capture itself, so the
                // ball must not start a drag from this button.
                OrbEvents.RaiseMenu();
                return;
            }
            if (e.Button != MouseButtons.Left) return;
            Point cursor;
            Win32.GetCursorPos(out cursor);
            this.pressed = true;
            this.dragging = false;
            this.pressCursor = cursor;
            this.pressWindow = new Point(this.Left, this.Top);
            this.Capture = true;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (!this.pressed) return;
            Point cursor;
            Win32.GetCursorPos(out cursor);
            int dx = cursor.X - this.pressCursor.X;
            int dy = cursor.Y - this.pressCursor.Y;
            if (!this.dragging && Math.Abs(dx) + Math.Abs(dy) > 4)
            {
                this.dragging = true;
                this.Repaint();
            }
            if (!this.dragging) return;
            this.MoveTo(this.pressWindow.X + dx, this.pressWindow.Y + dy);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (!this.pressed) return;
            this.pressed = false;
            this.Capture = false;
            bool wasDragging = this.dragging;
            this.dragging = false;
            if (wasDragging)
            {
                this.Repaint();
                EventHandler handler = this.Moved;
                if (handler != null) handler(this, EventArgs.Empty);
            }
            else
            {
                OrbEvents.RaiseClick();
            }
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            base.OnMouseEnter(e);
            this.SetHover(true);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (!this.pressed) this.SetHover(false);
        }

        protected override void OnCloseRequested()
        {
            OrbEvents.RaiseExit();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                Dispose(this.shadowNormal);
                Dispose(this.shadowHover);
                Dispose(this.baseSurface);
                Dispose(this.frameSurface);
                this.shadowNormal = null;
                this.shadowHover = null;
                this.baseSurface = null;
                this.frameSurface = null;
                if (this.badgeFont != null)
                {
                    this.badgeFont.Dispose();
                    this.badgeFont = null;
                }
            }
            base.Dispose(disposing);
        }

        private static void Dispose(Bitmap bitmap)
        {
            if (bitmap != null) bitmap.Dispose();
        }
    }

    internal sealed class BubbleWindow : LayeredWindow
    {
        private OrbSettings settings = new OrbSettings();
        private float scale = 1f;
        private string kicker = "";
        private string more = "";
        private Bitmap surface;
        private int cardWidth;
        private int cardHeight;
        private int margin;
        private double fade;
        private bool shown;
        private Rectangle closeHit;
        private string titleUsed = "";
        private int moreUsed;

        public int CardWidth
        {
            get { return this.cardWidth; }
        }

        public int CardHeight
        {
            get { return this.cardHeight; }
        }

        public int CardMargin
        {
            get { return this.margin; }
        }

        public Rectangle CardRect
        {
            get { return new Rectangle(this.Left + this.margin, this.Top + this.margin, this.cardWidth, this.cardHeight); }
        }

        public bool IsShown
        {
            get { return this.shown; }
        }

        public void SetScale(float value)
        {
            if (Math.Abs(value - this.scale) < 0.01f) return;
            this.scale = value;
            if (this.surface != null && this.CardMargin > 0)
            {
                Rectangle card = this.CardRect;
                this.Build(this.titleUsed, this.moreUsed, this.kicker, this.more);
                this.Location = new Point(card.X - this.margin, card.Y - this.margin);
            }
        }

        public void SetLabels(string kickerText, string moreText)
        {
            bool changed = kickerText != this.kicker || moreText != this.more;
            this.kicker = kickerText == null ? "" : kickerText;
            this.more = moreText == null ? "" : moreText;
            if (changed && this.surface != null) this.Build(this.titleUsed, this.moreUsed, this.kicker, this.more);
        }

        /// <summary>Measure and rasterise the card for one notice.</summary>
        public void Build(OrbSettings next, OrbNotice notice, string kickerText, string moreTemplate)
        {
            if (next != null) this.settings = next;
            this.kicker = kickerText == null ? "" : kickerText;
            string title = notice == null ? "" : notice.Title;
            int moreCount = notice == null ? 0 : notice.More;
            string moreText = "";
            if (moreCount > 0)
            {
                moreText = moreTemplate == null ? "" : moreTemplate.Replace("{n}", moreCount.ToString(CultureInfo.InvariantCulture));
            }
            this.Build(title, moreCount, this.kicker, moreText);
        }

        private void Build(string title, int moreCount, string kickerText, string moreText)
        {
            this.titleUsed = title;
            this.moreUsed = moreCount;
            this.more = moreText;
            this.margin = (int)Math.Round(26 * this.scale);
            int maxCard = (int)Math.Round(300 * this.scale);
            float padX = 12f * this.scale;
            float padTop = 9f * this.scale;
            float padBottom = 10f * this.scale;
            float gap = 2f * this.scale;
            float kickerHeight = 14f * this.scale;
            float lineHeight = 19f * this.scale;
            float blip = 5f * this.scale;
            bool cjk = Ink.NeedsCjk(title) || Ink.NeedsCjk(kickerText);
            string family = cjk ? "Microsoft YaHei UI" : "Segoe UI";

            Font titleFont = new Font(Ink.Family(Ink.NeedsCjk(title) ? "Microsoft YaHei UI" : "Segoe UI"),
                13.5f * this.scale, FontStyle.Regular, GraphicsUnit.Pixel);
            Font kickerFont = new Font(Ink.Family(family), 11f * this.scale, FontStyle.Regular, GraphicsUnit.Pixel);
            Font moreFont = new Font(Ink.Family(family), 11f * this.scale, FontStyle.Regular, GraphicsUnit.Pixel);
            try
            {
                float content;
                float titleHeight;
                List<string> lines;
                using (Bitmap probe = Ink.Canvas(8, 8))
                using (Graphics pg = Graphics.FromImage(probe))
                {
                    pg.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                    using (StringFormat format = Ink.Typographic())
                    {
                        float contentMax = maxCard - padX * 2f;
                        float titleWidth = string.IsNullOrEmpty(title) ? 0f : pg.MeasureString(title, titleFont, new PointF(0f, 0f), format).Width;
                        float kickerWidth = kickerText.Length == 0 ? 0f : pg.MeasureString(kickerText, kickerFont, new PointF(0f, 0f), format).Width + blip + 6f * this.scale;
                        float moreWidth = moreText.Length == 0 ? 0f : pg.MeasureString(moreText, moreFont, new PointF(0f, 0f), format).Width;
                        float desired = Math.Max(titleWidth, Math.Max(kickerWidth, moreWidth));
                        content = Math.Min(contentMax, Math.Max(60f * this.scale, desired));
                    }
                    lines = Ink.Wrap(pg, title, titleFont, content, 2);
                    titleHeight = Math.Max(1, lines.Count) * lineHeight;
                }
                this.cardWidth = (int)Math.Ceiling(content + padX * 2f);
                float body = padTop + (kickerText.Length > 0 ? kickerHeight : 0f) + gap + titleHeight;
                if (moreText.Length > 0) body += gap + 14f * this.scale;
                this.cardHeight = (int)Math.Ceiling(body + padBottom);
                int minHeight = (int)Math.Round(46 * this.scale);
                if (this.cardHeight < minHeight) this.cardHeight = minHeight;

                int width = this.cardWidth + this.margin * 2;
                int height = this.cardHeight + this.margin * 2;
                Bitmap canvas = Ink.Canvas(width, height);
                int[] close = new int[4];
                using (Graphics g = Ink.Begin(canvas))
                {
                    RectangleF card = new RectangleF(this.margin, this.margin, this.cardWidth, this.cardHeight);
                    float radius = 13f * this.scale;
                    using (Bitmap shadow = Ink.Shadow(width, height, card, radius, 12f * this.scale, 8f * this.scale, 87))
                    {
                        g.DrawImageUnscaled(shadow, 0, 0);
                    }

                    int alpha = (int)Math.Round(this.settings.BubbleAlpha * 255.0);
                    using (GraphicsPath path = Ink.RoundRect(card, radius))
                    using (SolidBrush brush = new SolidBrush(Color.FromArgb(alpha, Ink.BubbleBg)))
                    {
                        g.FillPath(brush, path);
                    }
                    using (GraphicsPath path = Ink.RoundRect(card, radius))
                    using (Pen pen = new Pen(Color.FromArgb(36, 255, 255, 255), Math.Max(1f, this.scale)))
                    {
                        g.DrawPath(pen, path);
                    }
                    using (GraphicsPath clip = Ink.RoundRect(card, radius))
                    {
                        Region previous = g.Clip;
                        g.SetClip(clip, CombineMode.Replace);
                        using (Pen pen = new Pen(Color.FromArgb(23, 255, 255, 255), Math.Max(1f, this.scale)))
                        {
                            g.DrawLine(pen, card.Left + 1f, card.Top + 0.5f, card.Right - 1f, card.Top + 0.5f);
                        }
                        g.Clip = previous;
                    }

                    using (StringFormat format = Ink.Typographic())
                    {
                        float x = card.Left + padX;
                        float y = card.Top + padTop;
                        if (kickerText.Length > 0)
                        {
                            float centerY = y + kickerHeight / 2f;
                            using (SolidBrush dot = new SolidBrush(Color.FromArgb(242, Ink.LiveDot)))
                            {
                                g.FillEllipse(dot, x, centerY - blip / 2f, blip, blip);
                            }
                            Ink.Text(g, kickerText, kickerFont, Color.FromArgb(158, 255, 255, 255),
                                new PointF(x + blip + 6f * this.scale, y), format);
                            y += kickerHeight + gap;
                        }
                        for (int i = 0; i < lines.Count; i++)
                        {
                            Ink.Text(g, lines[i], titleFont, Ink.TextPrimary,
                                new PointF(x, y + i * lineHeight), format);
                        }
                        y += titleHeight;
                        if (moreText.Length > 0)
                        {
                            y += gap;
                            Ink.Text(g, moreText, moreFont, Color.FromArgb(128, 255, 255, 255),
                                new PointF(x, y), format);
                        }
                    }

                    // Close button, straddling the top-right corner.
                    float size = 18f * this.scale;
                    RectangleF hit = new RectangleF(card.Right - 11f * this.scale, card.Top - 7f * this.scale, size, size);
                    close[0] = (int)Math.Round(hit.X);
                    close[1] = (int)Math.Round(hit.Y);
                    close[2] = (int)Math.Round(hit.Width);
                    close[3] = (int)Math.Round(hit.Height);
                    using (SolidBrush brush = new SolidBrush(Color.FromArgb(245, 30, 31, 38)))
                    {
                        g.FillEllipse(brush, hit);
                    }
                    using (Pen pen = new Pen(Color.FromArgb(41, 255, 255, 255), Math.Max(1f, this.scale)))
                    {
                        g.DrawEllipse(pen, hit);
                    }
                    Font glyphFont = new Font(Ink.Family("Segoe UI"), 12f * this.scale, FontStyle.Regular, GraphicsUnit.Pixel);
                    using (StringFormat centered = Ink.Centered())
                    using (SolidBrush brush = new SolidBrush(Color.FromArgb(184, 255, 255, 255)))
                    {
                        g.DrawString("\u00d7", glyphFont, brush, hit, centered);
                    }
                    glyphFont.Dispose();
                }
                this.closeHit = new Rectangle(close[0], close[1], close[2], close[3]);
                Dispose(this.surface);
                this.surface = canvas;
                this.Width = width;
                this.Height = height;
            }
            finally
            {
                titleFont.Dispose();
                kickerFont.Dispose();
                moreFont.Dispose();
            }
        }

        /// <summary>Show the card at zero alpha; the caller fades it in.</summary>
        public void ShowCard()
        {
            if (this.surface == null) return;
            this.shown = true;
            this.fade = 0;
            Present(this.surface, 0);
            if (this.IsHandleCreated)
            {
                this.Show();
                this.Raise();
            }
        }

        public void HideCard()
        {
            this.shown = false;
            this.fade = 0;
            if (this.IsHandleCreated) this.Hide();
        }

        public double Fade
        {
            get { return this.fade; }
        }

        public void SetFade(double value)
        {
            if (value < 0) value = 0;
            if (value > 1) value = 1;
            this.fade = value;
            Present(this.surface, (byte)Math.Round(value * 255));
        }

        public bool CloseHitTest(Point client)
        {
            return this.closeHit.Contains(client);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            if (this.closeHit.Contains(e.X, e.Y))
            {
                OrbEvents.RaiseClose();
                return;
            }
            OrbEvents.RaiseBubbleClick();
        }

        protected override void OnCloseRequested()
        {
            OrbEvents.RaiseExit();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                Dispose(this.surface);
                this.surface = null;
            }
            base.Dispose(disposing);
        }

        private static void Dispose(Bitmap bitmap)
        {
            if (bitmap != null) bitmap.Dispose();
        }
    }

    /// <summary>
    /// The ball's right-click menu, hand-drawn as its own layered window.
    /// ContextMenuStrip and ToolStripDropDown both need foreground activation,
    /// which a WS_EX_NOACTIVATE window can never obtain - the stock menu would
    /// disappear the instant it opened. So the menu is a peer of the orb: same
    /// layered presentation, no activation, and mouse capture (not focus) keeps
    /// the pointer while it is open, which is also how an outside click closes it.
    /// </summary>
    internal sealed class OrbMenuWindow : LayeredWindow
    {
        private sealed class Row
        {
            public string Label = "";
            public string Hint = "";
            public string Action = "";
            public bool Enabled = true;
            public bool Divider;
            public bool Info;
        }

        private readonly List<Row> rows = new List<Row>();
        private FontFamily latin;
        private FontFamily cjk;
        private Bitmap surface;
        private Bitmap shadowSurface;
        private Rectangle[] hits = new Rectangle[0];
        private float scale = 1f;
        private int cardWidth;
        private int cardHeight;
        private int margin;
        private int padX;
        private int padY;
        private int rowHeight;
        private int hintHeight;
        private int dividerHeight;
        private int hover = -1;
        private int openedAt;
        private int touchedAt;
        private bool open;

        public OrbMenuWindow()
        {
            this.latin = Ink.Family("Segoe UI");
            this.cjk = Ink.Family("Microsoft YaHei UI");
            // A title of its own: Probe.orbWindows and Takeover.CountOthers
            // recognise the ball by its exact window text, so a second window
            // called DSH_SESSION_ORB would read as a duplicate orb.
            this.Text = "DSH_SESSION_ORB_MENU";
            this.Hide();
        }

        public bool IsOpen
        {
            get { return this.open; }
        }

        /// <summary>
        /// Diagnostics hook. The application points this at orb.log so a menu that
        /// closes on its own can be explained from the log instead of guessed at.
        /// </summary>
        public static Action<string> Trace;

        private static void Note(string message)
        {
            Action<string> handler = Trace;
            if (handler != null) handler(message);
        }

        /// <summary>Opens the menu with the card's top-left corner at the cursor.</summary>
        public void ShowMenu(string lang, float dial, bool hasPending, Rectangle ball)
        {
            if (!this.IsHandleCreated || this.IsDisposed) return;
            this.scale = dial < 0.5f ? 0.5f : dial;
            MenuText text = MenuText.For(lang);

            this.rows.Clear();
            this.rows.Add(new Row { Label = text.OpenDsh, Action = "open-dsh" });
            this.rows.Add(new Row { Label = text.OpenLatest, Action = "open-latest", Enabled = hasPending });
            this.rows.Add(new Row { Divider = true });
            this.rows.Add(new Row { Label = text.Hide, Hint = text.HideHint, Action = "hide" });
            this.rows.Add(new Row { Label = text.Reset, Action = "reset" });
            this.rows.Add(new Row { Divider = true });
            this.rows.Add(new Row {
                Label = text.Info + " \u00b7 " + ((int)Math.Round(this.scale * 100f)) + "%",
                Info = true,
                Enabled = false
            });

            this.margin = (int)Math.Round(12 * this.scale);
            this.padX = (int)Math.Round(12 * this.scale);
            this.padY = (int)Math.Round(8 * this.scale);
            this.rowHeight = (int)Math.Round(30 * this.scale);
            this.hintHeight = (int)Math.Round(14 * this.scale);
            this.dividerHeight = (int)Math.Round(9 * this.scale);

            this.cardWidth = 0;
            using (Bitmap probe = new Bitmap(1, 1))
            using (Graphics g = Graphics.FromImage(probe))
            {
                for (int i = 0; i < this.rows.Count; i++)
                {
                    Row row = this.rows[i];
                    if (row.Divider) continue;
                    float content = this.Measure(g, row.Label, 12.5f);
                    if (row.Hint.Length > 0) content = Math.Max(content, this.Measure(g, row.Hint, 10f));
                    int needed = this.padX * 2 + (int)Math.Ceiling(content);
                    if (needed > this.cardWidth) this.cardWidth = needed;
                }
            }
            int minimum = (int)Math.Round(146 * this.scale);
            if (this.cardWidth < minimum) this.cardWidth = minimum;

            this.hits = new Rectangle[this.rows.Count];
            int y = this.margin + this.padY;
            for (int i = 0; i < this.rows.Count; i++)
            {
                Row row = this.rows[i];
                if (row.Divider)
                {
                    this.hits[i] = new Rectangle(this.margin, y, this.cardWidth, this.dividerHeight);
                    y += this.dividerHeight;
                    continue;
                }
                int bandHeight = this.rowHeight + (row.Hint.Length > 0 ? this.hintHeight : 0);
                this.hits[i] = new Rectangle(this.margin, y, this.cardWidth, bandHeight);
                y += bandHeight;
            }
            this.cardHeight = y + this.padY - this.margin;

            int width = this.cardWidth + this.margin * 2;
            int height = this.cardHeight + this.margin * 2;
            if (this.surface == null || this.surface.Width != width || this.surface.Height != height)
            {
                if (this.surface != null) this.surface.Dispose();
                if (this.shadowSurface != null) this.shadowSurface.Dispose();
                this.surface = Ink.Canvas(width, height);
                RectangleF card = new RectangleF(this.margin, this.margin, this.cardWidth, this.cardHeight);
                this.shadowSurface = Ink.Shadow(width, height, card, 10f * this.scale, 7f * this.scale, 2f * this.scale, 92);
            }
            this.Width = width;
            this.Height = height;
            this.hover = -1;
            this.PaintCard();

            // Place the card clear of the ball instead of on top of it: right
            // aligned with the ball, sitting just above it, flipping below when
            // the ball is docked near the top of the screen. Both ends are then
            // clamped into the monitor's work area.
            Rectangle work = Screen.FromRectangle(ball).WorkingArea;
            int gap = (int)Math.Round(10 * this.scale);
            int cardX = ball.Right - this.cardWidth;
            int cardY = ball.Top - gap - this.cardHeight;
            if (cardY < work.Top + 2) cardY = ball.Bottom + gap;
            int maxX = work.Right - this.cardWidth - 2;
            int maxY = work.Bottom - this.cardHeight - 2;
            if (cardX > maxX) cardX = maxX;
            if (cardX < work.Left + 2) cardX = work.Left + 2;
            if (cardY > maxY) cardY = maxY;
            if (cardY < work.Top + 2) cardY = work.Top + 2;
            this.MoveTo(cardX - this.margin, cardY - this.margin);

            this.open = true;
            this.openedAt = Environment.TickCount;
            this.touchedAt = this.openedAt;
            // Publish before showing, but after MoveTo: Present() reads Left/Top
            // for its destination rectangle and would otherwise place the surface
            // wherever the window happened to be a moment earlier.
            Present(this.surface, 255);
            if (!this.Visible) this.Show();
            this.Raise();
            this.AssertTopMost();
            this.Capture = true;
            Note("opened at " + this.Left + "," + this.Top + " " + this.Width + "x" + this.Height
                + " visible=" + this.Visible + " capture=" + this.Capture);
        }

        public void HideMenu()
        {
            if (!this.open && !this.Visible) return;
            Note("closing (open=" + this.open + " visible=" + this.Visible
                + " capture=" + this.Capture + " hover=" + this.hover + ")");
            this.open = false;
            this.hover = -1;
            try
            {
                if (this.Capture) this.Capture = false;
            }
            catch
            {
            }
            if (this.IsHandleCreated && !this.IsDisposed) this.Hide();
        }

        /// <summary>
        /// Watchdog: a menu that lost the mouse (another program grabbed capture)
        /// or sat untouched is stale and would otherwise hang over the desktop.
        /// </summary>
        public void Tick()
        {
            if (!this.open) return;
            int now = Environment.TickCount;
            if (now - this.openedAt < 700) return;
            if (!this.Capture)
            {
                Note("watchdog: capture lost after " + (now - this.openedAt) + " ms");
                this.HideMenu();
                return;
            }
            if (now - this.touchedAt > 12000)
            {
                Note("watchdog: idle " + (now - this.touchedAt) + " ms");
                this.HideMenu();
            }
        }

        private void PaintCard()
        {
            if (this.surface == null) return;
            RectangleF card = new RectangleF(this.margin, this.margin, this.cardWidth, this.cardHeight);
            float radius = 10f * this.scale;
            int insetX = (int)Math.Round(4 * this.scale);
            int insetY = (int)Math.Round(2 * this.scale);
            using (Graphics g = Ink.Begin(this.surface))
            {
                if (this.shadowSurface != null) g.DrawImageUnscaled(this.shadowSurface, 0, 0);
                using (GraphicsPath path = Ink.RoundRect(card, radius))
                {
                    using (SolidBrush brush = new SolidBrush(Color.FromArgb(247, Ink.BubbleBg)))
                    {
                        g.FillPath(brush, path);
                    }
                    using (Pen pen = new Pen(Color.FromArgb(30, 255, 255, 255), Math.Max(1f, 1f * this.scale)))
                    {
                        g.DrawPath(pen, path);
                    }
                }

                for (int i = 0; i < this.rows.Count; i++)
                {
                    Row row = this.rows[i];
                    Rectangle band = this.hits[i];
                    if (row.Divider)
                    {
                        int lineY = band.Y + band.Height / 2;
                        using (Pen pen = new Pen(Color.FromArgb(26, 255, 255, 255), 1f))
                        {
                            g.DrawLine(pen, band.Left + this.padX, lineY, band.Right - this.padX, lineY);
                        }
                        continue;
                    }

                    if (i == this.hover)
                    {
                        RectangleF lit = new RectangleF(
                            band.Left + insetX,
                            band.Top + insetY,
                            band.Width - insetX * 2,
                            band.Height - insetY * 2);
                        using (GraphicsPath path = Ink.RoundRect(lit, 7f * this.scale))
                        using (SolidBrush brush = new SolidBrush(Color.FromArgb(32, 255, 255, 255)))
                        {
                            g.FillPath(brush, path);
                        }
                    }

                    Color label = row.Enabled ? Ink.TextPrimary : Color.FromArgb(126, 247, 248, 250);
                    if (row.Info) label = Color.FromArgb(112, 247, 248, 250);
                    float textX = band.Left + this.padX;
                    using (Font labelFont = this.TextFont(row.Label, 12.5f))
                    using (Font hintFont = row.Hint.Length > 0 ? this.TextFont(row.Hint, 10f) : null)
                    using (StringFormat format = Ink.Typographic())
                    {
                        // Centre the text block by its measured line heights
                        // instead of guessing an ascent offset.
                        float labelHeight = labelFont.GetHeight(g);
                        float hintHeightPx = hintFont == null ? 0f : hintFont.GetHeight(g);
                        float top = band.Top + (band.Height - (labelHeight + hintHeightPx)) / 2f;
                        Ink.Text(g, row.Label, labelFont, label, new PointF(textX, top), format);
                        if (hintFont != null)
                        {
                            Ink.Text(g, row.Hint, hintFont, Color.FromArgb(150, 247, 248, 250),
                                new PointF(textX, top + labelHeight), format);
                        }
                    }
                }
            }
        }

        private float Measure(Graphics g, string text, float size)
        {
            using (Font font = this.TextFont(text, size))
            using (StringFormat format = Ink.Typographic())
            {
                return g.MeasureString(text, font, new PointF(0f, 0f), format).Width;
            }
        }

        private Font TextFont(string text, float size)
        {
            FontFamily family = Ink.NeedsCjk(text) ? this.cjk : this.latin;
            return new Font(family, size * this.scale, FontStyle.Regular, GraphicsUnit.Pixel);
        }

        private int HitTest(int x, int y)
        {
            for (int i = 0; i < this.hits.Length && i < this.rows.Count; i++)
            {
                Row row = this.rows[i];
                if (row.Divider || !row.Enabled || row.Action.Length == 0) continue;
                if (this.hits[i].Contains(x, y)) return i;
            }
            return -1;
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (!this.open) return;
            this.touchedAt = Environment.TickCount;
            Rectangle card = new Rectangle(this.margin, this.margin, this.cardWidth, this.cardHeight);
            if (!card.Contains(e.X, e.Y))
            {
                // Capture routes clicks from anywhere on screen here, so a click
                // that landed on the desktop, DSH, or the ball closes the menu.
                this.HideMenu();
                return;
            }
            if (e.Button != MouseButtons.Left) return;
            int index = this.HitTest(e.X, e.Y);
            if (index < 0) return;
            string action = this.rows[index].Action;
            // Act on press, not release: the menu holds the capture and is about
            // to disappear, so a matching button-up may never reach it.
            this.HideMenu();
            if (action.Length > 0) OrbEvents.RaiseMenuAction(action);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (!this.open) return;
            this.touchedAt = Environment.TickCount;
            int index = this.HitTest(e.X, e.Y);
            if (index == this.hover) return;
            this.hover = index;
            this.PaintCard();
            Present(this.surface, 255);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (!this.open || this.hover < 0) return;
            this.hover = -1;
            this.PaintCard();
            Present(this.surface, 255);
        }

        protected override void OnMouseCaptureChanged(EventArgs e)
        {
            base.OnMouseCaptureChanged(e);
            Note("capture-changed open=" + this.open + " capture=" + this.Capture);
            if (!this.open) return;
            if (this.Capture) return;
            // The release of the button that opened the menu arrives on this window
            // (it holds the capture) and drops the capture with it. Re-take it on the
            // next pump turn - the button-up is still being dispatched right now and
            // would drop it again - instead of treating it as a dismissal.
            if (Environment.TickCount - this.openedAt < 900)
            {
                try
                {
                    this.BeginInvoke(new MethodInvoker(this.RetakeCapture));
                }
                catch
                {
                    this.HideMenu();
                }
                return;
            }
            // Somebody else took the mouse: the menu can no longer see clicks, so
            // it must not stay on screen pretending to be interactive.
            this.HideMenu();
        }

        // Re-assert the capture the opening gesture took away, but only while the
        // menu is still inside its opening grace window; after that a lost capture
        // means a click landed somewhere else and the menu has to go.
        private void RetakeCapture()
        {
            if (!this.open) return;
            if (this.Capture) return;
            if (Environment.TickCount - this.openedAt >= 900)
            {
                Note("capture never came back, closing");
                this.HideMenu();
                return;
            }
            try
            {
                this.Capture = true;
            }
            catch
            {
            }
            Note("re-took capture=" + this.Capture);
            if (!this.Capture) this.HideMenu();
        }

        protected override void OnCloseRequested()
        {
            this.HideMenu();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (this.surface != null) this.surface.Dispose();
                if (this.shadowSurface != null) this.shadowSurface.Dispose();
                this.surface = null;
                this.shadowSurface = null;
            }
            base.Dispose(disposing);
        }
    }

    /// <summary>Bilingual menu labels, kept next to the menu that draws them.</summary>
    internal sealed class MenuText
    {
        public string OpenDsh = "Open DSH";
        public string OpenLatest = "Open latest session";
        public string Hide = "Hide the ball";
        public string HideHint = "Turn it back on in the DSH settings";
        public string Reset = "Move back to the corner";
        public string Info = "Independent window";

        public static MenuText For(string lang)
        {
            MenuText text = new MenuText();
            if (lang == null || !lang.StartsWith("zh", StringComparison.OrdinalIgnoreCase)) return text;
            text.OpenDsh = "\u6253\u5f00 DSH";
            text.OpenLatest = "\u6253\u5f00\u6700\u8fd1\u5b8c\u6210\u7684\u4f1a\u8bdd";
            text.Hide = "\u9690\u85cf\u60ac\u6d6e\u7403";
            text.HideHint = "\u56de DSH \u8bbe\u7f6e\u9875\u53ef\u4ee5\u518d\u6253\u5f00";
            text.Reset = "\u590d\u4f4d\u5230\u53f3\u4e0b\u89d2";
            text.Info = "\u72ec\u7acb\u7a97\u53e3";
            return text;
        }
    }

    /// <summary>Process-wide event hub so the windows never touch the network.</summary>
    internal static class OrbEvents
    {
        public static event Action Click;
        public static event Action BubbleClick;
        public static event Action Dismiss;
        public static event Action Exit;
        /// <summary>Right-click on the ball: open the context menu at the cursor.</summary>
        public static event Action Menu;
        /// <summary>A menu row was chosen; the payload is its action id.</summary>
        public static event Action<string> MenuAction;

        public static void RaiseClick()
        {
            Action handler = Click;
            if (handler != null) handler();
        }

        public static void RaiseBubbleClick()
        {
            Action handler = BubbleClick;
            if (handler != null) handler();
        }

        public static void RaiseClose()
        {
            Action handler = Dismiss;
            if (handler != null) handler();
        }

        public static void RaiseExit()
        {
            Action handler = Exit;
            if (handler != null) handler();
        }

        public static void RaiseMenu()
        {
            Action handler = Menu;
            if (handler != null) handler();
        }

        public static void RaiseMenuAction(string action)
        {
            Action<string> handler = MenuAction;
            if (handler != null) handler(action);
        }
    }

    internal sealed class HostClient
    {
        private readonly string origin;
        private readonly string token;
        private readonly Action<OrbState> onState;
        private readonly Action<string, string> onLog;
        private readonly Action onDead;
        private Thread streamThread;
        private Thread pingThread;
        private volatile bool stopping;
        private int failures;
        private int lastSeq = -1;

        public HostClient(string origin, string token, Action<OrbState> onState, Action<string, string> onLog, Action onDead)
        {
            this.origin = origin;
            this.token = token;
            this.onState = onState;
            this.onLog = onLog;
            this.onDead = onDead;
        }

        public void Start()
        {
            WebRequest.DefaultWebProxy = null;
            this.stopping = false;
            this.streamThread = new Thread(this.StreamLoop);
            this.streamThread.IsBackground = true;
            this.streamThread.Name = "orb-stream";
            this.streamThread.Start();
            this.pingThread = new Thread(this.PingLoop);
            this.pingThread.IsBackground = true;
            this.pingThread.Name = "orb-ping";
            this.pingThread.Start();
        }

        public void Stop()
        {
            this.stopping = true;
        }

        private HttpWebRequest Request(string path)
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(this.origin + path);
            request.Proxy = null;
            request.KeepAlive = true;
            request.Method = "GET";
            request.Timeout = 10000;
            request.ReadWriteTimeout = 600000;
            request.Headers["x-orb-token"] = this.token;
            request.ServicePoint.Expect100Continue = false;
            request.UserAgent = "dsh-session-orb";
            return request;
        }

        private void StreamLoop()
        {
            while (!this.stopping)
            {
                try
                {
                    HttpWebRequest request = this.Request("/orb/stream");
                    request.Timeout = 15000;
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    using (Stream stream = response.GetResponseStream())
                    using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                    {
                        string eventName = null;
                        StringBuilder data = new StringBuilder();
                        string line;
                        while (!this.stopping && (line = reader.ReadLine()) != null)
                        {
                            if (line.Length == 0)
                            {
                                if (data.Length > 0) this.Dispatch(data.ToString());
                                eventName = null;
                                data.Length = 0;
                                continue;
                            }
                            if (line[0] == ':') continue;
                            int colon = line.IndexOf(':');
                            if (colon < 0) continue;
                            string field = line.Substring(0, colon);
                            string value = line.Substring(colon + 1);
                            if (value.Length > 0 && value[0] == ' ') value = value.Substring(1);
                            if (field == "event") eventName = value;
                            else if (field == "data") data.Append(value);
                        }
                    }
                }
                catch (Exception error)
                {
                    if (!this.stopping && this.onLog != null) this.onLog("log", "stream: " + Short(error));
                }
                if (!this.stopping) Thread.Sleep(1200);
            }
        }

        private void PingLoop()
        {
            while (!this.stopping)
            {
                try
                {
                    HttpWebRequest request = this.Request("/orb/ping");
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    using (Stream stream = response.GetResponseStream())
                    using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                    {
                        string body = reader.ReadToEnd();
                        Dictionary<string, object> payload = Json.Parse(body) as Dictionary<string, object>;
                        if (payload != null)
                        {
                            this.failures = 0;
                            Dictionary<string, object> stateMap = Json.Object(Json.Get(payload, "state"));
                            if (stateMap != null) this.Dispatch(Json.ToJson(stateMap));
                        }
                    }
                }
                catch (Exception error)
                {
                    this.failures++;
                    if (this.onLog != null && this.failures == 1) this.onLog("log", "ping: " + Short(error));
                    if (this.failures >= 12)
                    {
                        if (this.onLog != null) this.onLog("error", "host unreachable after 12 pings");
                        if (this.onDead != null) this.onDead();
                        return;
                    }
                }
                for (int i = 0; i < 12 && !this.stopping; i++) Thread.Sleep(500);
            }
        }

        private void Dispatch(string data)
        {
            if (string.IsNullOrEmpty(data)) return;
            OrbState state;
            try
            {
                Dictionary<string, object> map = Json.Parse(data) as Dictionary<string, object>;
                if (map == null) return;
                state = OrbState.Parse(map);
            }
            catch (Exception error)
            {
                if (this.onLog != null) this.onLog("log", "parse: " + Short(error));
                return;
            }
            if (state.Seq > 0 && state.Seq == this.lastSeq) return;
            if (state.Seq > 0) this.lastSeq = state.Seq;
            if (this.onState != null) this.onState(state);
        }

        /// <summary>Fire-and-forget POST of a user gesture.</summary>
        public void Post(IDictionary<string, object> payload)
        {
            ThreadPool.QueueUserWorkItem(delegate(object ignored)
            {
                try
                {
                    HttpWebRequest request = this.Request("/orb/event");
                    request.Method = "POST";
                    request.ContentType = "application/json; charset=utf-8";
                    byte[] body = Encoding.UTF8.GetBytes(Json.ToJson(payload));
                    request.ContentLength = body.Length;
                    using (Stream stream = request.GetRequestStream())
                    {
                        stream.Write(body, 0, body.Length);
                    }
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    {
                        response.Close();
                    }
                }
                catch (Exception error)
                {
                    if (this.onLog != null) this.onLog("log", "post: " + Short(error));
                }
            });
        }

        private static string Short(Exception error)
        {
            if (error == null) return "unknown";
            string message = error.Message;
            if (string.IsNullOrEmpty(message)) message = error.GetType().Name;
            return message.Length > 200 ? message.Substring(0, 200) : message;
        }
    }

    internal sealed class OrbApplication : ApplicationContext
    {
        private readonly string origin;
        private readonly string token;
        private readonly int parentPid;
        private readonly OrbWindow orb;
        private readonly BubbleWindow bubble;
        private readonly OrbMenuWindow menu;
        private readonly FormsTimer uiTimer;
        private readonly FormsTimer frameTimer;
        private HostClient client;
        private OrbState state = new OrbState();
        private float scale = 1f;
        private int placed;
        private bool exiting;
        /// <summary>Why the ball is leaving, reported with `bye` so the Host can
        /// tell "the bridge went away" (restartable) from "the Host is exiting"
        /// (do not restart) without guessing.</summary>
        private string exitReason = "shutdown";
        private double fade;
        private int fadeDirection;
        /// <summary>Last z-order keep-on-top pass (Environment.TickCount).</summary>
        private long lastTopCheck;
        /// <summary>Last time the ball actually had to be raised.</summary>
        private long lastTopRaise;
        /// <summary>Log throttle for keep-on-top repairs; the repairs themselves
        /// are never throttled, only the lines they write.</summary>
        private long lastTopLog;
        private int suppressedTopLogs;
        /// <summary>Set from a SystemEvents thread to force a pass on the UI thread.</summary>
        private int forceTopCheck;
        private int noticeUntil;
        private long lastDpiCheck;
        private long lastParentCheck;
        private System.Threading.Timer startTimer;
        private OrbState pending;
        private bool published;
        private bool hidden;

        public OrbApplication(string origin, string token, int parentPid)
        {
            this.origin = origin;
            this.token = token;
            this.parentPid = parentPid;

            this.orb = new OrbWindow();
            this.bubble = new BubbleWindow();
            this.menu = new OrbMenuWindow();
            // CreateControl() does nothing for an invisible Form, so the handle
            // used to be created by whoever touched .Handle first - the SSE
            // thread, which has no message loop. That window was enumerable and
            // "visible" but could never publish a surface, receive a mouse
            // message, or run a BeginInvoke callback: a permanent zombie. Read
            // Handle here, on the thread that is about to pump the message loop.
            if (this.orb.Handle == IntPtr.Zero || this.bubble.Handle == IntPtr.Zero || this.menu.Handle == IntPtr.Zero)
            {
                throw new InvalidOperationException("orb window handle could not be created");
            }

            this.orb.Moved += this.OnOrbMoved;
            OrbMenuWindow.Trace = this.OnMenuTrace;
            Reveal.Trace(delegate(string message) { this.OnLog("log", message); });
            OrbEvents.Click += this.OnClick;
            OrbEvents.BubbleClick += this.OnBubbleClick;
            OrbEvents.Dismiss += this.OnDismiss;
            OrbEvents.Exit += this.OnExit;
            OrbEvents.Menu += this.OnMenu;
            OrbEvents.MenuAction += this.OnMenuAction;

            this.orb.Configure(this.state.Settings, null, 0);

            this.uiTimer = new FormsTimer();
            this.uiTimer.Interval = 500;
            this.uiTimer.Tick += this.OnTick;
            this.uiTimer.Start();

            this.frameTimer = new FormsTimer();
            this.frameTimer.Interval = 33;
            this.frameTimer.Tick += this.OnFrame;

            // Display topology, session unlock and theme changes all rearrange the
            // topmost band behind our back (a monitor coming back re-maps every
            // window). One pass on the next tick is enough to reclaim the front.
            SystemEvents.DisplaySettingsChanged += this.OnSystemEvent;
            SystemEvents.UserPreferenceChanged += this.OnSystemEvent;
            SystemEvents.SessionSwitch += this.OnSystemEvent;
        }

        /// <summary>
        /// Raised on a SystemEvents thread, so it only arms a flag: touching a Form
        /// from here is how the handle once ended up owned by the wrong thread.
        /// </summary>
        private void OnSystemEvent(object sender, EventArgs e)
        {
            if (this.exiting) return;
            this.RequestTopCheck();
        }

        /// <summary>Ask for a keep-on-top pass on the next tick.</summary>
        private void RequestTopCheck()
        {
            Interlocked.Exchange(ref this.forceTopCheck, 1);
        }

        public void Start()
        {
            this.client = new HostClient(this.origin, this.token, this.OnState, this.OnLog, this.OnHostDead);
            this.client.Start();
            this.startTimer = new System.Threading.Timer(this.OnStartup, null, 400, Timeout.Infinite);
        }

        private void OnStartup(object ignored)
        {
            this.Post(new Dictionary<string, object> {
                { "type", "ready" },
                { "pid", Process.GetCurrentProcess().Id },
                { "scale", this.scale },
                { "dpi", Dpi.Mode }
            });
        }

        private void OnState(OrbState incoming)
        {
            if (this.exiting || incoming == null) return;
            if (!this.orb.IsHandleCreated)
            {
                // Never touch a Form from the thread that delivered the event:
                // doing so is how the handle ended up owned by the SSE thread,
                // which cannot paint, take input, or run an invoke callback.
                this.pending = incoming;
                return;
            }
            try
            {
                this.orb.BeginInvoke(new Action<OrbState>(this.Apply), new object[] { incoming });
            }
            catch
            {
                this.pending = incoming;
            }
        }

        private void Apply(OrbState incoming)
        {
            if (this.exiting) return;
            OrbNotice previous = this.state.Notice;
            bool hadPosition = this.state.HasPosition;
            this.state = incoming;

            if (this.placed == 0)
            {
                this.scale = Dpi.ScaleOf(this.orb.Handle);
                this.orb.SetScale(this.scale);
                this.bubble.SetScale(this.scale);
            }

            this.orb.Configure(incoming.Settings, incoming.Notice, incoming.Running);
            // Before placement: ShowOrb() consults this flag, so a ball that is
            // switched off must know it before it is placed for the first time.
            this.ApplyVisibility(incoming.Settings.Visible);

            if (this.placed == 0)
            {
                if (incoming.HasPosition) this.PlaceAt(incoming.Position);
                else this.PlaceDefault();
            }
            else if (incoming.HasPosition)
            {
                // Re-place from the Host's position. v2.0.0 clamped the *current*
                // window position here, so the clamp returned what was already on
                // screen and this branch could never move anything: every
                // external change (reset, the one-shot v1 migration, a second
                // renderer, another display) was silently dropped while the Host
                // went on reporting the new coordinates as the live position.
                Rectangle work = Screen.FromRectangle(new Rectangle(incoming.Position.X, incoming.Position.Y, this.orb.Width, this.orb.Height)).WorkingArea;
                Point clamped = this.Clamp(incoming.Position.X, incoming.Position.Y, work);
                if (clamped.X != this.orb.Left || clamped.Y != this.orb.Top)
                {
                    this.orb.MoveTo(clamped.X, clamped.Y);
                    if (!this.hidden) this.orb.PresentRest();
                }
            }
            else if (hadPosition)
            {
                // A position that was cleared means "put it back in the corner".
                // Guarded by hadPosition so the steady state (no position stored)
                // does not re-place and re-post on every push.
                this.PlaceDefault();
            }

            bool noticeChanged = incoming.Notice != null && (previous == null || !incoming.Notice.SameAs(previous));
            if (noticeChanged && !this.hidden)
            {
                this.bubble.SetLabels(this.kicker(), this.moreLabel());
                this.bubble.Build(incoming.Settings, incoming.Notice, this.kicker(), this.moreLabel());
                this.PositionBubble();
                this.bubble.ShowCard();
                this.fade = 0;
                this.fadeDirection = 1;
                this.bubble.SetFade(0);
                int ms = incoming.Settings.BubbleMs;
                this.noticeUntil = ms > 0 ? unchecked(Environment.TickCount + ms) : 0;
                this.StartFrames();
            }
            else if (incoming.Notice == null && this.bubble.IsShown)
            {
                this.fadeDirection = -1;
                this.StartFrames();
            }

            this.UpdateFrames();
            if (!this.hidden) this.orb.PresentRest();
            if (!this.published && this.orb.HasSurface)
            {
                this.published = true;
                this.OnLog("log", "surface published " + this.orb.Width + "x" + this.orb.Height
                    + " scale=" + this.scale.ToString("0.##", CultureInfo.InvariantCulture)
                    + " thread=" + Thread.CurrentThread.ManagedThreadId
                    + " placed=" + this.placed + " visible=" + this.orb.Visible);
            }
        }

        private string kicker()
        {
            return this.state.Lang == "en" ? "Session finished" : "\u4f1a\u8bdd\u5b8c\u6210";
        }

        private string moreLabel()
        {
            return this.state.Lang == "en" ? "{n} more" : "\u8fd8\u6709 {n} \u6761";
        }

        private Point Clamp(int x, int y, Rectangle work)
        {
            int maxX = work.Right - this.orb.Width;
            int maxY = work.Bottom - this.orb.Height;
            if (x < work.Left) x = work.Left;
            if (y < work.Top) y = work.Top;
            if (x > maxX) x = Math.Max(work.Left, maxX);
            if (y > maxY) y = Math.Max(work.Top, maxY);
            return new Point(x, y);
        }

        private void PlaceAt(Point topLeft)
        {
            Rectangle work = Screen.FromRectangle(new Rectangle(topLeft.X, topLeft.Y, this.orb.Width, this.orb.Height)).WorkingArea;
            Point clamped = this.Clamp(topLeft.X, topLeft.Y, work);
            this.placed = 1;
            this.ShowOrb(clamped);
        }

        private void PlaceDefault()
        {
            Rectangle work = Screen.PrimaryScreen.WorkingArea;
            int margin = (int)Math.Round(18 * this.scale);
            int x = work.Right - this.orb.Width - margin + this.orb.Pad;
            int y = work.Bottom - this.orb.Height - margin + this.orb.Pad;
            this.placed = 1;
            Point clamped = this.Clamp(x, y, work);
            this.ShowOrb(clamped);
            this.Post(new Dictionary<string, object> {
                { "type", "drag-end" },
                { "reason", "default" },
                { "x", this.orb.Left },
                { "y", this.orb.Top },
                { "scale", this.scale }
            });
        }

        private void ShowOrb(Point topLeft)
        {
            this.orb.Location = topLeft;
            // A switched-off ball still records where it belongs, so turning it
            // back on puts it exactly where the user last left it.
            if (this.hidden) return;
            // Show first, then publish: Present() is a no-op until the handle
            // exists, so publishing first left a mapped window with no surface
            // (fully transparent - "visible" to Win32, empty to the eye).
            if (!this.orb.Visible) this.orb.Show();
            this.orb.PresentRest();
            this.orb.AssertTopMost();
            this.RequestTopCheck();
        }

        /// <summary>
        /// Applies the display switch. Off is a soft mute: the process, the SSE
        /// stream and the stored position all survive, so switching back on is
        /// instant and loses nothing. Nothing may be drawn, animated or raised
        /// while off - an invisible window that keeps calling SetWindowPos would
        /// still be a topmost window nobody can see or click.
        /// </summary>
        private void ApplyVisibility(bool visible)
        {
            if (!visible)
            {
                if (this.hidden) return;
                this.hidden = true;
                this.bubble.HideCard();
                this.fade = 0;
                this.fadeDirection = 0;
                if (this.frameTimer.Enabled) this.frameTimer.Stop();
                if (this.menu.IsOpen) this.menu.HideMenu();
                if (this.orb.Visible) this.orb.Hide();
                this.OnLog("log", "orb hidden (settings.visible=false)");
                return;
            }

            if (!this.hidden) return;
            this.hidden = false;
            if (this.placed != 0)
            {
                if (!this.orb.Visible) this.orb.Show();
                this.orb.PresentRest();
                this.orb.AssertTopMost();
                this.RequestTopCheck();
            }
            this.UpdateFrames();
            this.OnLog("log", "orb shown (settings.visible=true)");
        }

        private void PositionBubble()
        {
            if (!this.bubble.IsShown && this.state.Notice == null) return;
            Rectangle ball = this.orb.BallRect;
            Rectangle work = Screen.FromRectangle(ball).WorkingArea;
            int gap = (int)Math.Round(10 * this.scale);
            int cardWidth = this.bubble.CardWidth;
            int cardHeight = this.bubble.CardHeight;
            int x = ball.Left + (ball.Width - cardWidth) / 2;
            int y = ball.Top - gap - cardHeight;
            if (y < work.Top + 4)
            {
                y = ball.Bottom + gap;
                if (y + cardHeight > work.Bottom - 4) y = work.Bottom - 4 - cardHeight;
            }
            if (x < work.Left + 8) x = ball.Left;
            if (x + cardWidth > work.Right - 8) x = ball.Right - cardWidth;
            if (x < work.Left + 4) x = work.Left + 4;
            if (x + cardWidth > work.Right - 4) x = Math.Max(work.Left + 4, work.Right - 4 - cardWidth);
            this.bubble.Location = new Point(x - this.bubble.CardMargin, y - this.bubble.CardMargin);
            this.bubble.Raise();
        }

        private void OnOrbMoved(object sender, EventArgs e)
        {
            Rectangle ball = this.orb.BallRect;
            Rectangle work = Screen.FromRectangle(ball).WorkingArea;
            Point clamped = this.Clamp(this.orb.Left, this.orb.Top, work);
            if (clamped.X != this.orb.Left || clamped.Y != this.orb.Top)
            {
                this.orb.MoveTo(clamped.X, clamped.Y);
                this.orb.PresentRest();
            }
            float current = Dpi.ScaleOf(this.orb.Handle);
            if (Math.Abs(current - this.scale) > 0.01f)
            {
                this.scale = current;
                this.orb.SetScale(current);
                this.bubble.SetScale(current);
            }
            if (this.bubble.IsShown) this.PositionBubble();
            this.RequestTopCheck();
            this.Post(new Dictionary<string, object> {
                { "type", "drag-end" },
                { "reason", "drag" },
                { "x", this.orb.Left },
                { "y", this.orb.Top },
                { "scale", this.scale }
            });
        }

        /// <summary>True when the ring should be advancing.</summary>
        private bool Pulsing()
        {
            return this.state.Running > 0 && this.state.Settings.Pulse && !this.orb.IsDragging
                && this.placed != 0 && !this.hidden;
        }

        private void StartFrames()
        {
            if (!this.frameTimer.Enabled) this.frameTimer.Start();
        }

        private void UpdateFrames()
        {
            if (this.Pulsing() || this.fadeDirection != 0) this.StartFrames();
            else if (this.frameTimer.Enabled) this.frameTimer.Stop();
        }

        private void OnFrame(object sender, EventArgs e)
        {
            if (this.exiting) return;
            const float dt = 0.033f;
            bool pulsing = this.Pulsing();
            if (pulsing) this.orb.Animate(dt);

            if (this.fadeDirection != 0)
            {
                double step = 33.0 / 160.0;
                if (this.fadeDirection > 0)
                {
                    this.fade += step;
                    if (this.fade >= 1.0)
                    {
                        this.fade = 1.0;
                        this.fadeDirection = 0;
                    }
                    this.bubble.SetFade(this.fade);
                }
                else
                {
                    this.fade -= step;
                    if (this.fade <= 0.0)
                    {
                        this.fade = 0.0;
                        this.fadeDirection = 0;
                        this.bubble.HideCard();
                    }
                    else
                    {
                        this.bubble.SetFade(this.fade);
                    }
                }
            }

            if (!pulsing && this.fadeDirection == 0)
            {
                this.frameTimer.Stop();
                if (this.state.Running > 0 && this.state.Settings.Pulse) this.orb.PresentRest();
            }
        }

        private void OnClick()
        {
            if (this.exiting) return;
            bool hadNotice = this.state.Notice != null;
            this.Post(new Dictionary<string, object> {
                { "type", "ball-click" },
                { "hadNotice", hadNotice }
            });
            Reveal.OnWorker();
        }

        private void OnBubbleClick()
        {
            if (this.exiting) return;
            string sessionId = this.state.Notice == null ? "" : this.state.Notice.SessionId;
            this.Post(new Dictionary<string, object> {
                { "type", "bubble-click" },
                { "sessionId", sessionId }
            });
            Reveal.OnWorker();
        }

        private void OnDismiss()
        {
            if (this.exiting) return;
            this.Post(new Dictionary<string, object> { { "type", "bubble-close" } });
            this.fadeDirection = -1;
            if (this.fade <= 0.0) this.fade = 0.999;
            this.StartFrames();
        }

        private void OnMenuTrace(string message)
        {
            this.OnLog("log", "menu: " + message);
        }

        private void OnMenu()
        {
            if (this.exiting || this.hidden) return;
            // The notice card and the menu cannot share the screen: the card sits
            // right above the ball, where the menu opens, and would swallow the
            // clicks meant for the first row. Hide it without telling the Host -
            // this is not a dismissal, the notice stays in the queue.
            if (this.bubble.IsShown) this.bubble.HideCard();
            this.fade = 0;
            this.fadeDirection = 0;
            this.UpdateFrames();
            // Ball bounds, not the cursor: the menu is placed relative to the ball
            // so it never covers it (see ShowMenu).
            this.menu.ShowMenu(this.state.Lang, this.scale, this.state.Notice != null, this.orb.Bounds);
        }

        private void OnMenuAction(string action)
        {
            if (this.exiting || action == null) return;
            if (action == "open-dsh")
            {
                Reveal.OnWorker();
                return;
            }
            if (action == "open-latest")
            {
                this.Post(new Dictionary<string, object> {
                    { "type", "menu" },
                    { "action", "open-latest" }
                });
                // The Host can only queue the command; the renderer may be
                // throttled to about one timer per minute while hidden, so bring
                // DSH forward from here instead of waiting for it.
                Reveal.OnWorker();
                return;
            }
            if (action == "hide")
            {
                this.Post(new Dictionary<string, object> {
                    { "type", "menu" },
                    { "action", "hide" }
                });
                // Hide first, persist second: the ball must disappear on the same
                // click, and the Host echo of settings.visible=false then lands on
                // an already hidden window (ApplyVisibility is idempotent).
                this.ApplyVisibility(false);
                return;
            }
            if (action == "reset")
            {
                this.PlaceDefault();
            }
        }

        private void OnLog(string level, string message)
        {
            if (this.exiting) return;
            this.Post(new Dictionary<string, object> {
                { "type", level == "error" ? "error" : "log" },
                { "message", message == null ? "" : message }
            });
        }

        /// <summary>The bridge has been unreachable for twelve pings: nothing can
        /// drive the ball any more, so leave and say why.</summary>
        private void OnHostDead()
        {
            this.exitReason = "host-unreachable";
            this.OnExit();
        }

        private void OnExit()
        {
            if (this.exiting) return;
            this.exiting = true;
            try
            {
                SystemEvents.DisplaySettingsChanged -= this.OnSystemEvent;
                SystemEvents.UserPreferenceChanged -= this.OnSystemEvent;
                SystemEvents.SessionSwitch -= this.OnSystemEvent;
            }
            catch
            {
                // Static event sources are process-wide; a failure here can only
                // matter for a helper that is already leaving.
            }
            try
            {
                this.uiTimer.Stop();
                this.frameTimer.Stop();
                if (this.startTimer != null) this.startTimer.Dispose();
                this.Post(new Dictionary<string, object> {
                    { "type", "bye" },
                    { "reason", this.exitReason }
                });
                if (this.client != null) this.client.Stop();
            }
            catch
            {
            }
            try
            {
                if (this.orb != null) this.orb.Hide();
                if (this.bubble != null) this.bubble.HideCard();
                if (this.menu != null)
                {
                    this.menu.HideMenu();
                    this.menu.Dispose();
                }
            }
            catch
            {
            }
            this.ExitThread();
        }

        private void OnTick(object sender, EventArgs e)
        {
            if (this.exiting) return;
            if (this.pending != null)
            {
                OrbState next = this.pending;
                this.pending = null;
                this.Apply(next);
            }
            long now = Environment.TickCount;
            this.menu.Tick();
            bool forced = Interlocked.Exchange(ref this.forceTopCheck, 0) != 0;
            if (forced || now - this.lastTopCheck >= 500)
            {
                this.lastTopCheck = now;
                this.KeepOnTop(now, forced);
            }
            if (now - this.lastDpiCheck > 5000)
            {
                this.lastDpiCheck = now;
                float current = Dpi.ScaleOf(this.orb.Handle);
                if (Math.Abs(current - this.scale) > 0.01f)
                {
                    this.scale = current;
                    this.orb.SetScale(current);
                    this.bubble.SetScale(current);
                    if (this.bubble.IsShown)
                    {
                        this.bubble.Build(this.state.Settings, this.state.Notice, this.kicker(), this.moreLabel());
                        this.PositionBubble();
                    }
                    if (!this.hidden) this.orb.PresentRest();
                }
            }
            if (now - this.lastParentCheck > 3000)
            {
                this.lastParentCheck = now;
                if (!Reveal.ParentAlive(this.parentPid))
                {
                    // The Host process is gone: there is nobody left to talk to,
                    // and a restart would only flash another ball on screen.
                    this.exitReason = "parent-gone";
                    this.OnExit();
                }
            }
        }

        /// <summary>
        /// Keeps the ball - and the card above it - at the front of the topmost
        /// band, roughly twice a second.
        ///
        /// The old watchdog only re-asserted the WS_EX_TOPMOST bit every 4 s, so a
        /// ball whose bit was intact and whose z-order had been overtaken by any
        /// other always-on-top window stayed buried until that window went away:
        /// "topmost" flickering off was really "still topmost, just not the
        /// topmost-most". A pass that changes nothing costs one GetWindowLong call.
        /// </summary>
        private void KeepOnTop(long now, bool forced)
        {
            if (this.exiting || this.hidden || this.placed == 0) return;

            // While the menu is open the user is touching this helper's own
            // window: raising the ball over the menu would swallow the click.
            if (this.menu.IsOpen)
            {
                string menuNote;
                if (this.menu.EnsureOnTop(out menuNote)) this.NoteTopmost("menu " + menuNote, now);
                return;
            }

            // After a raise, give the world a moment before looking again: this
            // bounds the work at one repair per 1.5 s even if an invisible overlay
            // keeps reporting itself as a cover.
            if (!forced && now - this.lastTopRaise < 1500) return;

            string note;
            if (this.orb.EnsureOnTop(out note))
            {
                this.lastTopRaise = now;
                this.NoteTopmost("ball " + note, now);
                // The card belongs above the ball by design; a ball that has just
                // moved to the front of the band would otherwise cover its card.
                if (this.bubble.IsShown) this.bubble.Raise();
            }
            if (this.bubble.IsShown && this.bubble.EnsureOnTop(out note))
            {
                this.lastTopRaise = now;
                this.NoteTopmost("card " + note, now);
            }
        }

        /// <summary>
        /// One log line per repair burst. A repair that repeats every 1.5 s would
        /// otherwise write a line every 1.5 s forever and bury the rest of the log.
        /// </summary>
        private void NoteTopmost(string note, long now)
        {
            if (now - this.lastTopLog < 60000)
            {
                this.suppressedTopLogs += 1;
                return;
            }
            this.lastTopLog = now;
            string suffix = this.suppressedTopLogs == 0
                ? ""
                : " (+" + this.suppressedTopLogs.ToString(CultureInfo.InvariantCulture) + " more since the last line)";
            this.suppressedTopLogs = 0;
            this.OnLog("log", "topmost: " + note + suffix);
        }

        private void Post(IDictionary<string, object> payload)
        {
            if (this.client != null) this.client.Post(payload);
        }

        /// <summary>
        /// Last words before a crash. The Host logs these as orb.log lines, so a
        /// silent death (0xCFFFFFFF with no message) becomes a diagnosable one.
        /// </summary>
        public void ReportFatal(Exception error)
        {
            string message = "unknown";
            if (error != null)
            {
                message = error.GetType().Name + ": " + error.Message;
                if (!string.IsNullOrEmpty(error.StackTrace))
                {
                    string trace = error.StackTrace.Replace("\r", " ").Replace("\n", " | ");
                    if (trace.Length > 400) trace = trace.Substring(0, 400);
                    message = message + " @ " + trace;
                }
            }
            if (message.Length > 700) message = message.Substring(0, 700);
            try
            {
                this.Post(new Dictionary<string, object> {
                    { "type", "fatal" },
                    { "message", message }
                });
            }
            catch
            {
            }
            Console.Error.WriteLine("session-orb: fatal: " + message);
        }

        public void RequestExit()
        {
            this.OnExit();
        }
    }

    /// <summary>Bringing DSH back is a supported desktop gesture, not a hack.</summary>
    internal static class Reveal
    {
        private static IntPtr cached;
        private static long cachedAt;
        private static Action<string> trace;
        private static int revealing;

        public static void OnWorker()
        {
            ThreadPool.QueueUserWorkItem(delegate(object ignored)
            {
                try
                {
                    RevealDsh();
                }
                catch
                {
                }
            });
        }

        public static bool ParentAlive(int pid)
        {
            if (pid <= 0) return true;
            try
            {
                Process process = Process.GetProcessById(pid);
                bool alive = !process.HasExited;
                process.Dispose();
                return alive;
            }
            catch
            {
                return false;
            }
        }

        public static IntPtr FindDshWindow()
        {
            IntPtr found = IntPtr.Zero;
            long bestArea = -1;
            IntPtr last = cached;
            Win32.EnumWindows(delegate(IntPtr hwnd, IntPtr lparam)
            {
                StringBuilder cls = new StringBuilder(256);
                if (Win32.GetClassNameW(hwnd, cls, cls.Capacity) == 0) return true;
                if (cls.ToString() != "Chrome_WidgetWin_1") return true;
                uint pid;
                Win32.GetWindowThreadProcessId(hwnd, out pid);
                string exe = ProcessName(pid);
                if (exe == null || exe.IndexOf("DeepSeek", StringComparison.OrdinalIgnoreCase) < 0) return true;
                StringBuilder title = new StringBuilder(512);
                Win32.GetWindowTextW(hwnd, title, title.Capacity);
                if (title.Length == 0) return true;
                Win32.RECT rect;
                if (!Win32.GetWindowRect(hwnd, out rect)) return true;
                // A minimized window has no usable rect: Windows answers
                // -32000,-32000 with a 237x39 stub, which the old guard read as
                // "not DSH" and dropped. Finding it is what lets the ball restore
                // a minimized DSH instead of failing to locate it at all.
                if (!Win32.IsIconic(hwnd) && (rect.Width < 200 || rect.Height < 200)) return true;
                long area = (long)rect.Width * (long)rect.Height;
                if (hwnd == last) area += 100000000L;
                if (area <= bestArea) return true;
                bestArea = area;
                found = hwnd;
                return true;
            }, IntPtr.Zero);
            if (found != IntPtr.Zero)
            {
                cached = found;
                cachedAt = Environment.TickCount;
            }
            return found;
        }

        public static string ProcessName(uint pid)
        {
            string path = ProcessPath(pid);
            return path == null ? null : Path.GetFileName(path);
        }

        public static string ProcessPath(uint pid)
        {
            IntPtr handle = Win32.OpenProcess(Win32.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (handle == IntPtr.Zero) return null;
            try
            {
                StringBuilder buffer = new StringBuilder(1024);
                int size = buffer.Capacity;
                if (!Win32.QueryFullProcessImageNameW(handle, 0, buffer, ref size)) return null;
                return buffer.ToString();
            }
            catch
            {
                return null;
            }
            finally
            {
                Win32.CloseHandle(handle);
            }
        }

        /// <summary>
        /// Diagnostics hook; the application points this at orb.log.
        /// </summary>
        public static void Trace(Action<string> handler)
        {
            trace = handler;
        }

        /// <summary>
        /// Ask the running DSH instance to show its window.
        ///
        /// Chromium tracks window visibility in its own widget/compositor state,
        /// so the window has to be shown by something Chromium itself handles.
        /// WM_SYSCOMMAND/SC_RESTORE goes through its window procedure and works
        /// for both a minimized and a tray-hidden window: measured, the window
        /// comes back and repaints. Calling ShowWindow(SW_RESTORE/SW_SHOW) here
        /// instead maps the HWND without touching that state - the page then
        /// never submits another frame and the window sticks on its last frame
        /// until DSH is restarted (the frozen window this used to cause).
        /// </summary>
        public static void RevealDsh()
        {
            // One reveal at a time. The ball click, the bubble click and two menu
            // rows each queue a worker; without this guard they overlap, every one
            // spawning a second instance and parking in WaitShown - the v3.1
            // regression that left the window stuck minimized and unresponsive
            // when the user clicked repeatedly (live 2026-11-16 00:15).
            if (Interlocked.CompareExchange(ref revealing, 1, 0) != 0) return;
            try
            {
                IntPtr hwnd = FindDshWindow();
                if (hwnd == IntPtr.Zero)
                {
                    TraceLine("reveal: no DSH window found; asking the dsh:// protocol");
                    AskProtocol();
                    return;
                }
                if (Win32.IsWindowVisible(hwnd) && !Win32.IsIconic(hwnd))
                {
                    ForceForeground(hwnd);
                    return;
                }
                // Step 1: map the HWND through Chromium's own window procedure.
                // SC_RESTORE reliably brings the window on screen from BOTH the
                // minimized and the tray-hidden state, so the orb never looks dead.
                // On its own the page may still think it is hidden (frozen
                // painting); step 2 addresses that, but appearing first is what
                // keeps reveal from ever failing to show a window.
                TraceLine("reveal: SC_RESTORE (visible=" + Win32.IsWindowVisible(hwnd) + " iconic=" + Win32.IsIconic(hwnd) + ")");
                Win32.PostMessageW(hwnd, Win32.WM_SYSCOMMAND, new IntPtr(Win32.SC_RESTORE), IntPtr.Zero);
                WaitShown(hwnd, 1200);
                // Step 2: exactly ONE second-instance launch. It lands in
                // focusPrimaryWindow() -> BrowserWindow.show(), the only route the
                // sandbox replica measured that restores a tray-hidden page to
                // visibilityState=visible. Once, never in a loop, never concurrent.
                TraceLine("reveal: SC_RESTORE then one second instance");
                RelaunchDsh(hwnd);
                if (WaitShown(hwnd, 3000))
                {
                    ForceForeground(hwnd);
                    return;
                }
                // Step 3: the dsh:// protocol reaches the same focusPrimaryWindow
                // through a different delivery path (open-url).
                TraceLine("reveal: not shown yet; trying dsh://open");
                AskProtocol();
                if (WaitShown(hwnd, 1500))
                {
                    ForceForeground(hwnd);
                    return;
                }
                TraceLine("reveal: done (no raw ShowWindow - it freezes painting)");
            }
            finally
            {
                Interlocked.Exchange(ref revealing, 0);
            }
        }

        private static void RelaunchDsh(IntPtr hwnd)
        {
            try
            {
                uint pid;
                Win32.GetWindowThreadProcessId(hwnd, out pid);
                string path = ProcessPath(pid);
                if (string.IsNullOrEmpty(path)) return;
                TraceLine("reveal: second instance " + path);
                Win32.ShellExecuteW(IntPtr.Zero, "open", path, null, Path.GetDirectoryName(path), Win32.SW_SHOWNORMAL);
            }
            catch (Exception error)
            {
                TraceLine("reveal: second instance failed: " + error.Message);
            }
        }

        private static void AskProtocol()
        {
            try
            {
                Win32.ShellExecuteW(IntPtr.Zero, "open", "dsh://open", null, null, Win32.SW_SHOWNORMAL);
            }
            catch
            {
            }
        }

        /// <summary>Visible and not minimized: the page is on screen and repainting.</summary>
        private static bool WaitShown(IntPtr hwnd, int millis)
        {
            const int step = 50;
            int waited = 0;
            while (true)
            {
                if (Win32.IsWindow(hwnd) && Win32.IsWindowVisible(hwnd) && !Win32.IsIconic(hwnd)) return true;
                if (waited >= millis) return false;
                Thread.Sleep(step);
                waited += step;
            }
        }

        private static void TraceLine(string message)
        {
            Action<string> handler = trace;
            if (handler == null) return;
            try
            {
                handler(message);
            }
            catch
            {
            }
        }

        /// <summary>
        /// SetForegroundWindow is refused for processes that are not foreground and
        /// did not receive the last input. Our own window is WS_EX_NOACTIVATE by
        /// design, so it can never legitimately hold the foreground; attaching to
        /// the current foreground thread's input queue is the sanctioned way round.
        /// </summary>
        public static void ForceForeground(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return;
            if (Win32.IsIconic(hwnd)) Win32.ShowWindow(hwnd, Win32.SW_RESTORE);
            IntPtr foreground = Win32.GetForegroundWindow();
            uint ignored;
            uint attachTo = Win32.GetWindowThreadProcessId(foreground, out ignored);
            uint mine = Win32.GetCurrentThreadId();
            bool attached = false;
            try
            {
                if (attachTo != 0 && attachTo != mine) attached = Win32.AttachThreadInput(mine, attachTo, true);
                Win32.BringWindowToTop(hwnd);
                Win32.SetForegroundWindow(hwnd);
            }
            catch
            {
            }
            finally
            {
                if (attached) Win32.AttachThreadInput(mine, attachTo, false);
            }
        }

        public static long CachedAt
        {
            get { return cachedAt; }
        }
    }

    internal sealed class Args
    {
        private readonly Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public static Args Parse(string[] argv)
        {
            Args parsed = new Args();
            if (argv == null) return parsed;
            for (int i = 0; i < argv.Length; i++)
            {
                string item = argv[i];
                if (string.IsNullOrEmpty(item)) continue;
                if (item.StartsWith("--")) item = item.Substring(2);
                int equals = item.IndexOf('=');
                if (equals > 0)
                {
                    parsed.values[item.Substring(0, equals)] = item.Substring(equals + 1);
                    continue;
                }
                if (i + 1 < argv.Length && !argv[i + 1].StartsWith("--"))
                {
                    parsed.values[item] = argv[++i];
                    continue;
                }
                parsed.values[item] = "1";
            }
            return parsed;
        }

        public bool Has(string key)
        {
            return this.values.ContainsKey(key);
        }

        public string Get(string key, string fallback)
        {
            string value;
            return this.values.TryGetValue(key, out value) ? value : fallback;
        }

        public int GetInt(string key, int fallback)
        {
            string value = this.Get(key, null);
            if (value == null) return fallback;
            int parsed;
            return int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) ? parsed : fallback;
        }
    }

    internal static class Probe
    {
        public static int Run(Args args)
        {
            Dictionary<string, object> report = new Dictionary<string, object>();
            report["ok"] = true;
            report["dpiAware"] = Dpi.Mode;
            report["pid"] = Process.GetCurrentProcess().Id;

            List<object> screens = new List<object>();
            try
            {
                Screen[] all = Screen.AllScreens;
                for (int i = 0; i < all.Length; i++)
                {
                    Dictionary<string, object> screen = new Dictionary<string, object>();
                    screen["device"] = all[i].DeviceName;
                    screen["primary"] = all[i].Primary;
                    screen["bounds"] = Json.Rect(all[i].Bounds);
                    screen["work"] = Json.Rect(all[i].WorkingArea);
                    screens.Add(screen);
                }
            }
            catch (Exception error)
            {
                report["screenError"] = error.Message;
            }
            report["screens"] = screens;

            Dictionary<string, object> dsh = new Dictionary<string, object>();
            IntPtr hwnd = Reveal.FindDshWindow();
            dsh["hwnd"] = hwnd.ToInt64();
            if (hwnd != IntPtr.Zero)
            {
                uint pid;
                Win32.GetWindowThreadProcessId(hwnd, out pid);
                Win32.RECT rect;
                Win32.GetWindowRect(hwnd, out rect);
                int ex = Win32.GetWindowLongW(hwnd, Win32.GWL_EXSTYLE);
                StringBuilder cls = new StringBuilder(256);
                Win32.GetClassNameW(hwnd, cls, cls.Capacity);
                StringBuilder title = new StringBuilder(512);
                Win32.GetWindowTextW(hwnd, title, title.Capacity);
                dsh["pid"] = pid;
                dsh["class"] = cls.ToString();
                dsh["title"] = title.ToString();
                dsh["visible"] = Win32.IsWindowVisible(hwnd);
                dsh["minimized"] = Win32.IsIconic(hwnd);
                dsh["rect"] = Json.RectOf(rect);
                dsh["exStyle"] = "0x" + ex.ToString("x8", CultureInfo.InvariantCulture);
                dsh["topmost"] = (ex & Win32.WS_EX_TOPMOST) != 0;
                dsh["exe"] = Reveal.ProcessPath(pid);
            }
            report["dsh"] = dsh;

            List<object> orbs = new List<object>();
            Win32.EnumWindows(delegate(IntPtr window, IntPtr lparam)
            {
                StringBuilder cls = new StringBuilder(256);
                if (Win32.GetClassNameW(window, cls, cls.Capacity) == 0) return true;
                StringBuilder title = new StringBuilder(512);
                Win32.GetWindowTextW(window, title, title.Capacity);
                if (title.ToString() != "DSH_SESSION_ORB") return true;
                Win32.RECT rect;
                Win32.GetWindowRect(window, out rect);
                int ex = Win32.GetWindowLongW(window, Win32.GWL_EXSTYLE);
                Dictionary<string, object> entry = new Dictionary<string, object>();
                entry["hwnd"] = window.ToInt64();
                entry["class"] = cls.ToString();
                entry["visible"] = Win32.IsWindowVisible(window);
                entry["rect"] = Json.RectOf(rect);
                entry["exStyle"] = "0x" + ex.ToString("x8", CultureInfo.InvariantCulture);
                entry["topmost"] = (ex & Win32.WS_EX_TOPMOST) != 0;
                entry["layered"] = (ex & Win32.WS_EX_LAYERED) != 0;
                entry["noActivate"] = (ex & Win32.WS_EX_NOACTIVATE) != 0;
                entry["toolWindow"] = (ex & Win32.WS_EX_TOOLWINDOW) != 0;
                orbs.Add(entry);
                return true;
            }, IntPtr.Zero);
            report["orbWindows"] = orbs;

            string json = Json.ToJson(report);
            string outPath = args.Get("out", null);
            if (!string.IsNullOrEmpty(outPath))
            {
                try
                {
                    File.WriteAllText(outPath, json, new UTF8Encoding(false));
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine("probe: cannot write " + outPath + ": " + error.Message);
                    return 3;
                }
            }
            else
            {
                Console.Out.Write(json);
                Console.Out.Flush();
            }
            return 0;
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] argv)
        {
            // Never show a native error popup (disk/hard-error dialogs, crash
            // reporter prompts). We report through the bridge and stderr only.
            try
            {
                uint old = Win32.SetErrorMode(0);
                Win32.SetErrorMode(old | Win32.SEM_FAILCRITICALERRORS | Win32.SEM_NOGPFAULTERRORBOX | Win32.SEM_NOOPENFILEERRORBOX);
            }
            catch
            {
            }
            // Before any window, bitmap or Screen query: without this every
            // coordinate we read back would be virtualised at 96 DPI.
            Dpi.Enable();
            Args args = Args.Parse(argv);

            if (args.Has("probe")) return Probe.Run(args);

            string origin = args.Get("origin", null);
            string token = args.Get("token", null);
            int parent = args.GetInt("parent", 0);
            // "undefined"/"null" arrive when the Host hands us a placeholder
            // instead of a real token (Node stringifies a missing value). Such a
            // helper would pass every local check, get 403 on the bridge, and
            // then die quietly after twelve failed pings — a ball that vanishes
            // a minute after it appears. Refuse it here, loudly, instead.
            if (string.IsNullOrEmpty(origin) || string.IsNullOrEmpty(token) || token == "undefined" || token == "null")
            {
                Console.Error.WriteLine("session-orb: --origin and a real --token are required");
                return 2;
            }

            Takeover.CloseDuplicates();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            // Route UI-thread exceptions to our reporter instead of the default
            // "unhandled exception" dialog, which cannot be answered headless.
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);

            OrbApplication app = new OrbApplication(origin, token, parent);
            Application.ThreadException += delegate(object sender, System.Threading.ThreadExceptionEventArgs e)
            {
                app.ReportFatal(e.Exception);
            };
            AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
            {
                app.ReportFatal(e.ExceptionObject as Exception);
            };
            app.Start();
            try
            {
                Application.Run(app);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("session-orb: " + error);
                return 4;
            }
            finally
            {
                app.RequestExit();
            }
            Environment.Exit(0);
            return 0;
        }
    }

    internal static class Takeover
    {
        /// <summary>
        /// A stale helper from a previous Host run would draw a second orb. Ask any
        /// existing one to close and give it a moment, then start regardless: a
        /// duplicate orb is a cosmetic bug, a missing orb is a broken feature.
        /// </summary>
        public static void CloseDuplicates()
        {
            List<IntPtr> found = new List<IntPtr>();
            Win32.EnumWindows(delegate(IntPtr window, IntPtr lparam)
            {
                StringBuilder title = new StringBuilder(512);
                Win32.GetWindowTextW(window, title, title.Capacity);
                if (title.ToString() != "DSH_SESSION_ORB") return true;
                uint pid;
                Win32.GetWindowThreadProcessId(window, out pid);
                if (pid == (uint)Process.GetCurrentProcess().Id) return true;
                found.Add(window);
                return true;
            }, IntPtr.Zero);
            if (found.Count == 0) return;
            for (int i = 0; i < found.Count; i++) Win32.PostMessageW(found[i], Win32.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            for (int attempt = 0; attempt < 12; attempt++)
            {
                Thread.Sleep(100);
                if (CountOthers() == 0) return;
            }
        }

        private static int CountOthers()
        {
            int count = 0;
            uint self = (uint)Process.GetCurrentProcess().Id;
            Win32.EnumWindows(delegate(IntPtr window, IntPtr lparam)
            {
                StringBuilder title = new StringBuilder(512);
                Win32.GetWindowTextW(window, title, title.Capacity);
                if (title.ToString() != "DSH_SESSION_ORB") return true;
                uint pid;
                Win32.GetWindowThreadProcessId(window, out pid);
                if (pid != self) count++;
                return true;
            }, IntPtr.Zero);
            return count;
        }
    }
}
