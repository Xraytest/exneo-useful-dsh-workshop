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

        public const int SW_SHOWNORMAL = 1;
        public const int SW_SHOW = 5;
        public const int SW_RESTORE = 9;

        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const int MDT_EFFECTIVE_DPI = 0;

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
                && this.Badge == other.Badge;
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

    internal static class Paint
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
        /// Re-assert membership of the topmost band. Another program calling
        /// SetWindowPos(HWND_NOTOPMOST) strips the bit, and the window never comes
        /// back on its own, so this runs on a slow watchdog.
        /// </summary>
        public void AssertTopMost()
        {
            if (!this.IsHandleCreated || this.IsDisposed) return;
            if (this.TopMostPresent) return;
            Win32.SetWindowPos(this.Handle, Win32.HWND_TOPMOST, 0, 0, 0, 0,
                Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
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

        public int Padding
        {
            get { return this.padding; }
        }

        public float Scale
        {
            get { return this.scale; }
        }

        public bool IsDragging
        {
            get { return this.dragging; }
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
            this.shadowNormal = Paint.Shadow(this.total, this.total, ball, radius, blur, 8f * this.scale, 107);
            this.shadowHover = Paint.Shadow(this.total, this.total, ball, radius + 2f, blur + 2f, 10f * this.scale, 128);

            if (this.badgeFont != null)
            {
                this.badgeFont.Dispose();
                this.badgeFont = null;
            }
            if (this.badgeText.Length > 0)
            {
                this.badgeFont = new Font(Paint.Family("Segoe UI"), 10f * this.scale, FontStyle.Bold, GraphicsUnit.Pixel);
            }

            this.sizeChangedPending = true;
            this.RenderBase();
        }

        private bool sizeChangedPending;

        private void RenderBase()
        {
            Dispose(this.baseSurface);
            this.baseSurface = Paint.Canvas(this.total, this.total);
            using (Graphics g = Paint.Begin(this.baseSurface))
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

                using (GraphicsPath path = Paint.RoundRect(shape, radius * scaleFactor))
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
                using (GraphicsPath clip = Paint.RoundRect(shape, radius * scaleFactor))
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
                    using (StringFormat measureFormat = Paint.Typographic())
                    {
                        SizeF measured = g.MeasureString(this.badgeText, this.badgeFont, new PointF(0f, 0f), measureFormat);
                        float badgeWidth = Math.Max(badgeHeight, measured.Width + 8f * this.scale);
                        RectangleF badge = new RectangleF(
                            shape.Right - 5f * this.scale - badgeWidth,
                            shape.Top + 5f * this.scale,
                            badgeWidth,
                            badgeHeight);
                        using (GraphicsPath path = Paint.RoundRect(badge, badgeHeight / 2f))
                        using (SolidBrush brush = new SolidBrush(Color.FromArgb((int)Math.Round(opacity * 255.0), Paint.BadgeColor)))
                        {
                            g.FillPath(brush, path);
                        }
                        using (StringFormat centered = Paint.Centered())
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
                this.frameSurface = Paint.Canvas(this.total, this.total);
            }
            using (Graphics g = Paint.Begin(this.frameSurface))
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
                    using (GraphicsPath path = Paint.RoundRect(ring, radius + grow))
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
        private int bubbleMs;

        public int CardWidth
        {
            get { return this.cardWidth; }
        }

        public int CardHeight
        {
            get { return this.cardHeight; }
        }

        public int Margin
        {
            get { return this.margin; }
        }

        public Rectangle CardRect
        {
            get { return new Rectangle(this.Left + this.margin, this.Top + this.margin, this.cardWidth, this.cardHeight); }
        }

        public bool Shown
        {
            get { return this.shown; }
        }

        public void SetScale(float value)
        {
            if (Math.Abs(value - this.scale) < 0.01f) return;
            this.scale = value;
            if (this.surface != null && this.Margin > 0)
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
            bool cjk = Paint.NeedsCjk(title) || Paint.NeedsCjk(kickerText);
            string family = cjk ? "Microsoft YaHei UI" : "Segoe UI";

            Font titleFont = new Font(Paint.Family(Paint.NeedsCjk(title) ? "Microsoft YaHei UI" : "Segoe UI"),
                13.5f * this.scale, FontStyle.Regular, GraphicsUnit.Pixel);
            Font kickerFont = new Font(Paint.Family(family), 11f * this.scale, FontStyle.Regular, GraphicsUnit.Pixel);
            Font moreFont = new Font(Paint.Family(family), 11f * this.scale, FontStyle.Regular, GraphicsUnit.Pixel);
            try
            {
                float content;
                float titleHeight;
                List<string> lines;
                using (Bitmap probe = Paint.Canvas(8, 8))
                using (Graphics pg = Graphics.FromImage(probe))
                {
                    pg.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                    using (StringFormat format = Paint.Typographic())
                    {
                        float contentMax = maxCard - padX * 2f;
                        float titleWidth = string.IsNullOrEmpty(title) ? 0f : pg.MeasureString(title, titleFont, new PointF(0f, 0f), format).Width;
                        float kickerWidth = kickerText.Length == 0 ? 0f : pg.MeasureString(kickerText, kickerFont, new PointF(0f, 0f), format).Width + blip + 6f * this.scale;
                        float moreWidth = moreText.Length == 0 ? 0f : pg.MeasureString(moreText, moreFont, new PointF(0f, 0f), format).Width;
                        float desired = Math.Max(titleWidth, Math.Max(kickerWidth, moreWidth));
                        content = Math.Min(contentMax, Math.Max(60f * this.scale, desired));
                    }
                    lines = Paint.Wrap(pg, title, titleFont, content, 2);
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
                Bitmap canvas = Paint.Canvas(width, height);
                int[] close = new int[4];
                using (Graphics g = Paint.Begin(canvas))
                {
                    RectangleF card = new RectangleF(this.margin, this.margin, this.cardWidth, this.cardHeight);
                    float radius = 13f * this.scale;
                    using (Bitmap shadow = Paint.Shadow(width, height, card, radius, 12f * this.scale, 8f * this.scale, 87))
                    {
                        g.DrawImageUnscaled(shadow, 0, 0);
                    }

                    int alpha = (int)Math.Round(this.settings.BubbleAlpha * 255.0);
                    using (GraphicsPath path = Paint.RoundRect(card, radius))
                    using (SolidBrush brush = new SolidBrush(Color.FromArgb(alpha, Paint.BubbleBg)))
                    {
                        g.FillPath(brush, path);
                    }
                    using (GraphicsPath path = Paint.RoundRect(card, radius))
                    using (Pen pen = new Pen(Color.FromArgb(36, 255, 255, 255), Math.Max(1f, this.scale)))
                    {
                        g.DrawPath(pen, path);
                    }
                    using (GraphicsPath clip = Paint.RoundRect(card, radius))
                    {
                        Region previous = g.Clip;
                        g.SetClip(clip, CombineMode.Replace);
                        using (Pen pen = new Pen(Color.FromArgb(23, 255, 255, 255), Math.Max(1f, this.scale)))
                        {
                            g.DrawLine(pen, card.Left + 1f, card.Top + 0.5f, card.Right - 1f, card.Top + 0.5f);
                        }
                        g.Clip = previous;
                    }

                    using (StringFormat format = Paint.Typographic())
                    {
                        float x = card.Left + padX;
                        float y = card.Top + padTop;
                        if (kickerText.Length > 0)
                        {
                            float centerY = y + kickerHeight / 2f;
                            using (SolidBrush dot = new SolidBrush(Color.FromArgb(242, Paint.LiveDot)))
                            {
                                g.FillEllipse(dot, x, centerY - blip / 2f, blip, blip);
                            }
                            Paint.Text(g, kickerText, kickerFont, Color.FromArgb(158, 255, 255, 255),
                                new PointF(x + blip + 6f * this.scale, y), format);
                            y += kickerHeight + gap;
                        }
                        for (int i = 0; i < lines.Count; i++)
                        {
                            Paint.Text(g, lines[i], titleFont, Paint.TextPrimary,
                                new PointF(x, y + i * lineHeight), format);
                        }
                        y += titleHeight;
                        if (moreText.Length > 0)
                        {
                            y += gap;
                            Paint.Text(g, moreText, moreFont, Color.FromArgb(128, 255, 255, 255),
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
                    Font glyphFont = new Font(Paint.Family("Segoe UI"), 12f * this.scale, FontStyle.Regular, GraphicsUnit.Pixel);
                    using (StringFormat centered = Paint.Centered())
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

    /// <summary>Process-wide event hub so the windows never touch the network.</summary>
    internal static class OrbEvents
    {
        public static event Action Click;
        public static event Action BubbleClick;
        public static event Action Dismiss;
        public static event Action Exit;

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
        private readonly FormsTimer uiTimer;
        private readonly FormsTimer frameTimer;
        private HostClient client;
        private OrbState state = new OrbState();
        private float scale = 1f;
        private int placed;
        private bool exiting;
        private double fade;
        private int fadeDirection;
        private long lastTopMostCheck;
        private long lastDpiCheck;
        private long lastParentCheck;
        private System.Threading.Timer startTimer;

        public OrbApplication(string origin, string token, int parentPid)
        {
            this.origin = origin;
            this.token = token;
            this.parentPid = parentPid;

            this.orb = new OrbWindow();
            this.orb.CreateControl();
            this.bubble = new BubbleWindow();
            this.bubble.CreateControl();

            this.orb.Moved += this.OnOrbMoved;
            OrbEvents.Click += this.OnClick;
            OrbEvents.BubbleClick += this.OnBubbleClick;
            OrbEvents.Dismiss += this.OnDismiss;
            OrbEvents.Exit += this.OnExit;

            this.orb.Configure(this.state.Settings, null, 0);

            this.uiTimer = new FormsTimer();
            this.uiTimer.Interval = 500;
            this.uiTimer.Tick += this.OnTick;
            this.uiTimer.Start();

            this.frameTimer = new FormsTimer();
            this.frameTimer.Interval = 33;
            this.frameTimer.Tick += this.OnFrame;
        }

        public void Start()
        {
            this.client = new HostClient(this.origin, this.token, this.OnState, this.OnLog, this.OnExit);
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
                this.Apply(incoming);
                return;
            }
            try
            {
                this.orb.BeginInvoke(new Action<OrbState>(this.Apply), new object[] { incoming });
            }
            catch
            {
            }
        }

        private void Apply(OrbState incoming)
        {
            if (this.exiting) return;
            OrbNotice previous = this.state.Notice;
            this.state = incoming;

            if (this.placed == 0)
            {
                this.scale = Dpi.ScaleOf(this.orb.Handle);
                this.orb.SetScale(this.scale);
                this.bubble.SetScale(this.scale);
            }

            this.orb.Configure(incoming.Settings, incoming.Notice, incoming.Running);

            if (this.placed == 0)
            {
                if (incoming.HasPosition) this.PlaceAt(incoming.Position);
                else this.PlaceDefault();
            }
            else if (incoming.HasPosition)
            {
                Rectangle work = Screen.FromRectangle(new Rectangle(incoming.Position.X, incoming.Position.Y, this.orb.Width, this.orb.Height)).WorkingArea;
                Point clamped = this.Clamp(this.orb.Left, this.orb.Top, work);
                this.orb.MoveTo(clamped.X, clamped.Y);
            }

            bool noticeChanged = incoming.Notice != null && (previous == null || !incoming.Notice.SameAs(previous));
            if (noticeChanged)
            {
                this.bubble.SetLabels(this.kicker(), this.moreLabel());
                this.bubble.Build(incoming.Settings, incoming.Notice, this.kicker(), this.moreLabel());
                this.PositionBubble();
                this.bubble.ShowCard();
                this.fade = 0;
                this.fadeDirection = 1;
                this.bubble.SetFade(0);
                this.StartFrames();
            }
            else if (incoming.Notice == null && this.bubble.Shown)
            {
                this.fadeDirection = -1;
                this.StartFrames();
            }

            this.UpdateFrames();
            this.orb.PresentRest();
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
            int x = work.Right - this.orb.Width - margin + this.orb.Padding;
            int y = work.Bottom - this.orb.Height - margin + this.orb.Padding;
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
            this.orb.PresentRest();
            if (!this.orb.Visible) this.orb.Show();
            this.orb.AssertTopMost();
        }

        private void PositionBubble()
        {
            if (!this.bubble.Shown && this.state.Notice == null) return;
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
            this.bubble.Location = new Point(x - this.bubble.Margin, y - this.bubble.Margin);
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
            if (this.bubble.Shown) this.PositionBubble();
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
            return this.state.Running > 0 && this.state.Settings.Pulse && !this.orb.IsDragging && this.placed != 0;
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

        private void OnLog(string level, string message)
        {
            if (this.exiting) return;
            this.Post(new Dictionary<string, object> {
                { "type", level == "error" ? "error" : "log" },
                { "message", message == null ? "" : message }
            });
        }

        private void OnExit()
        {
            if (this.exiting) return;
            this.exiting = true;
            try
            {
                this.uiTimer.Stop();
                this.frameTimer.Stop();
                if (this.startTimer != null) this.startTimer.Dispose();
                this.Post(new Dictionary<string, object> { { "type", "bye" } });
                if (this.client != null) this.client.Stop();
            }
            catch
            {
            }
            try
            {
                if (this.orb != null) this.orb.Hide();
                if (this.bubble != null) this.bubble.HideCard();
            }
            catch
            {
            }
            this.ExitThread();
        }

        private void OnTick(object sender, EventArgs e)
        {
            if (this.exiting) return;
            long now = Environment.TickCount;
            if (now - this.lastTopMostCheck > 4000)
            {
                this.lastTopMostCheck = now;
                this.orb.AssertTopMost();
                if (this.bubble.Shown) this.bubble.AssertTopMost();
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
                    if (this.bubble.Shown)
                    {
                        this.bubble.Build(this.state.Settings, this.state.Notice, this.kicker(), this.moreLabel());
                        this.PositionBubble();
                    }
                    this.orb.PresentRest();
                }
            }
            if (now - this.lastParentCheck > 3000)
            {
                this.lastParentCheck = now;
                if (!Reveal.ParentAlive(this.parentPid)) this.OnExit();
            }
        }

        private void Post(IDictionary<string, object> payload)
        {
            if (this.client != null) this.client.Post(payload);
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
                if (rect.Width < 200 || rect.Height < 200) return true;
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
        /// Ask the running DSH instance to show its window. A second launch hits
        /// the single-instance lock and lands in claimDesktopSingleInstance's
        /// callback, which is focusPrimaryWindow(): show() + focus(). Showing the
        /// HWND directly instead would leave Chromium's renderer believing it is
        /// still hidden, and the page would never repaint.
        /// </summary>
        public static void RevealDsh()
        {
            IntPtr hwnd = FindDshWindow();
            if (hwnd == IntPtr.Zero)
            {
                try
                {
                    Win32.ShellExecuteW(IntPtr.Zero, "open", "dsh://open", null, null, Win32.SW_SHOWNORMAL);
                }
                catch
                {
                }
                return;
            }
            if (Win32.IsWindowVisible(hwnd) && !Win32.IsIconic(hwnd))
            {
                ForceForeground(hwnd);
                return;
            }
            uint pid;
            Win32.GetWindowThreadProcessId(hwnd, out pid);
            string path = ProcessPath(pid);
            if (!string.IsNullOrEmpty(path))
            {
                IntPtr result = Win32.ShellExecuteW(IntPtr.Zero, "open", path, null, Path.GetDirectoryName(path), Win32.SW_SHOWNORMAL);
                if ((long)result > 32)
                {
                    for (int i = 0; i < 60; i++)
                    {
                        if (Win32.IsWindowVisible(hwnd) && !Win32.IsIconic(hwnd)) break;
                        Thread.Sleep(50);
                    }
                    if (Win32.IsWindowVisible(hwnd))
                    {
                        ForceForeground(hwnd);
                        return;
                    }
                }
            }
            Win32.ShowWindow(hwnd, Win32.SW_RESTORE);
            Win32.ShowWindow(hwnd, Win32.SW_SHOW);
            ForceForeground(hwnd);
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
            // Before any window, bitmap or Screen query: without this every
            // coordinate we read back would be virtualised at 96 DPI.
            Dpi.Enable();
            Args args = Args.Parse(argv);

            if (args.Has("probe")) return Probe.Run(args);

            string origin = args.Get("origin", null);
            string token = args.Get("token", null);
            int parent = args.GetInt("parent", 0);
            if (string.IsNullOrEmpty(origin) || string.IsNullOrEmpty(token))
            {
                Console.Error.WriteLine("session-orb: --origin and --token are required");
                return 2;
            }

            Takeover.CloseDuplicates();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            OrbApplication app = new OrbApplication(origin, token, parent);
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
