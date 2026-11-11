/**
 * bilibili 公开 API 客户端（Host 侧，Node >= 20 内置 fetch）。
 *
 * 已实测（2026-11-07）免登录可用：
 *   - /x/web-interface/search/type?search_type=video|article  搜索（需完整浏览器 UA + Referer，裸 UA 触发 412 风控页）
 *   - /x/web-interface/view?bvid=               视频详情
 *   - /x/player/pagelist?bvid=                  分P列表
 *   - /x/tag/archive/tags?aid=                  视频标签
 *   - /x/v2/reply/main?type=1&oid=aid           评论（老 /x/v2/reply 匿名空壳化，必须用 main；
 *                                                mode=3 间歇性返回空，空时回退 mode=2；置顶在 top_replies）
 *   - /x/article/view?id=cv                     专栏正文 —— 需 WBI 签名 + buvid3/4 cookie，裸调 -352/-509
 *   - /x/frontend/finger/spi                    匿名拿 buvid3/buvid4（引导用）
 *   - /x/web-interface/nav                      匿名拿 wbi_img keys（code=-101 但 data.wbi_img 仍在）
 *
 * @module dsh-bilibili/lib/api
 */
import { createHash } from 'node:crypto';
import { deltaToText } from './delta.js';

const API = 'https://api.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** WBI mixinKey 重排表（社区逆向公开算法，非机密）。 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

/** 输出体量上限（结构化 value 与 render 共用同一策略）。 */
export const LIMITS = {
  articleText: 30000, // 专栏正文字符
  videoDesc: 4000, // 视频简介
  summary: 500, // 专栏摘要
  searchSnippet: 300, // 搜索结果摘要（结构化）
  renderSnippet: 120, // 搜索结果摘要（渲染行）
  maxImages: 50, // 专栏图片列出上限
  maxPages: 200, // 分P 列出上限
};

const md5hex = (s) => createHash('md5').update(s, 'utf8').digest('hex');

function getMixinKey(imgKey, subKey) {
  const orig = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32);
}

/** WBI 签名：参数排序 + wts + md5(query+mixinKey) => w_rid。 */
export function encWbi(params, imgKey, subKey, wts = Math.round(Date.now() / 1000)) {
  const mixinKey = getMixinKey(imgKey, subKey);
  const chrfilter = /[!'\(\)*]/g;
  const withWts = { ...params, wts };
  const query = Object.keys(withWts)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(withWts[key]).replace(chrfilter, ''))}`)
    .join('&');
  return `${query}&w_rid=${md5hex(query + mixinKey)}`;
}

/** 把 Set-Cookie 串解析进 jar；空值即删除（服务器删除语义），上限 50 键。 */
function absorbCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const sc of list) {
    const [pair] = sc.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (v === '') { delete jar[k]; continue; }
    jar[k] = v;
  }
  const keys = Object.keys(jar);
  if (keys.length > 50) {
    // 超限丢最旧（JS 对象键保持插入序，重新赋值不移动位置——够用）
    for (const k of keys.slice(0, keys.length - 50)) delete jar[k];
  }
}

/** 剥除搜索标题里的 <em class="keyword"> 高亮与其它标签。 */
export function stripHtml(text) {
  return String(text ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .trim();
}

/** 中和换行/回车（外部单行文本进 render 前统一过一道，防伪造列表行）。 */
export function oneLine(text, max = 300) {
  return String(text ?? '').replace(/\r?\n/g, ' ').slice(0, max);
}

/** Unix 秒 → ISO 字符串（失败返回 undefined）。 */
function isoOf(unix) {
  const n = Number(unix);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n * 1000).toISOString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 网络层瞬态错误（fetch failed / undici / DNS / TCP）→ 可重试。实测 api.bilibili.com 会轮换到不可达边缘 IP。 */
function isTransientNetworkError(error) {
  const codes = [error?.cause?.code, error?.cause?.cause?.code, error?.code];
  if (codes.some((c) => typeof c === 'string' && /^(UND_ERR|ECONN|ETIMEDOUT|EAI_AGAIN|EPIPE|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL)/.test(c))) return true;
  const msg = String(error?.message ?? error?.cause?.message ?? '');
  return msg.includes('fetch failed') || msg.includes('Connect Timeout') || msg.includes('Socket') || msg.includes('network');
}

/** 错误归一化：目标输入截断、远端 message 标注。 */
function apiError(code, message) {
  const friendly = code === -352 || code === -412 ? '风控拦截（疑似频次过高或 IP 被限）'
    : code === -509 ? '请求过于频繁'
      : code === -404 ? '内容不存在'
        : code === -400 ? '请求参数错误' : '';
  const remote = typeof message === 'string' && message !== '' && message !== String(code) ? `（远端消息：${oneLine(message, 120)}）` : '';
  return new Error(`bilibili API 错误 ${code}${friendly ? `：${friendly}` : ''}${remote}`);
}

/**
 * 有状态客户端：buvid 引导 + WBI keys 缓存 + 串行节流 + 风控退避重试。
 * 生命周期跟随插件 apply（进程级单例即可，不需要落盘）。
 */
export class BiliClient {
  /** @param {{ cookie?: string, timeoutMs?: number, logger?: any }} options */
  constructor(options = {}) {
    this.userCookie = typeof options.cookie === 'string' ? options.cookie.trim() : '';
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 20000;
    this.logger = options.logger;
    this.jar = {};
    if (this.userCookie !== '') {
      for (const pair of this.userCookie.split(';')) {
        const eq = pair.indexOf('=');
        if (eq > 0) {
          const k = pair.slice(0, eq).trim();
          const v = pair.slice(eq + 1).trim();
          if (k && v) this.jar[k] = v;
        }
      }
    }
    this.wbiKeys = null; // { imgKey, subKey, fetchedAt }
    this.wbiPromise = null;
    this.spiPromise = null;
    // 串行化队列：请求（含 body 读取）逐个进行，天然消除节流竞态
    this.queue = Promise.resolve();
    this.lastRequestAt = 0;
    this.minIntervalMs = 350; // 简单节流，降低 -509/-412 概率
    this.retryRound = 1; // 指数退避轮次（1→2）
  }

  log(level, message) {
    const sink = this.logger?.[level];
    if (typeof sink === 'function') {
      try { sink.call(this.logger, `[dsh-bilibili] ${message}`); } catch { /* 日志非关键路径 */ }
    }
  }

  cookieHeader() {
    const entries = Object.entries(this.jar);
    return entries.length === 0 ? '' : entries.map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** 匿名引导 buvid3/buvid4（一次性，缓存 promise；失败允许下轮重试）。 */
  async ensureSpi() {
    if (this.jar.buvid3 && this.jar.buvid4) return;
    if (!this.spiPromise) {
      this.spiPromise = (async () => {
        try {
          const res = await this.raw(`${API}/x/frontend/finger/spi`, {});
          const data = await res.json();
          if (data.code === 0 && data.data?.b_3) {
            this.jar.buvid3 = data.data.b_3;
            if (data.data.b_4) this.jar.buvid4 = data.data.b_4;
            this.log('info', 'buvid bootstrap ok');
          }
        } catch (error) {
          this.log('warn', `buvid bootstrap failed: ${String(error?.message ?? error)}`);
        } finally {
          this.spiPromise = null;
        }
      })();
    }
    await this.spiPromise;
  }

  /** 拉取（并缓存约 24h）WBI img/sub key；匿名 nav 返回 code:-101 但 wbi_img 仍在；in-flight 去重。 */
  async ensureWbiKeys() {
    const fresh = this.wbiKeys && Date.now() - this.wbiKeys.fetchedAt < 24 * 3600 * 1000;
    if (fresh) return this.wbiKeys;
    if (!this.wbiPromise) {
      this.wbiPromise = (async () => {
        try {
          const res = await this.raw(`${API}/x/web-interface/nav`, {});
          const data = await res.json();
          const imgUrl = data.data?.wbi_img?.img_url ?? '';
          const subUrl = data.data?.wbi_img?.sub_url ?? '';
          const imgKey = imgUrl.split('/').pop()?.split('.')[0] ?? '';
          const subKey = subUrl.split('/').pop()?.split('.')[0] ?? '';
          if (imgKey === '' || subKey === '') throw new Error('无法获取 WBI keys（nav 响应异常）');
          this.wbiKeys = { imgKey, subKey, fetchedAt: Date.now() };
          return this.wbiKeys;
        } finally {
          this.wbiPromise = null;
        }
      })();
    }
    return this.wbiPromise;
  }

  /**
   * 单请求（含 body 读取）纳入超时与串行节流。
   * @returns {Promise<Response>} 已完成 body 下载前的响应对象（json 由调用方在同一个锁内读取）
   */
  async raw(url, headers = {}) {
    const cookie = this.cookieHeader();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': UA,
          referer: 'https://www.bilibili.com/',
          accept: 'application/json',
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        signal: controller.signal,
      });
      absorbCookies(res, this.jar);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  /** json 读取与超时绑定：header 到达后 body 可能挂起，race 掉。 */
  async readJson(res) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`bilibili 响应超时（${this.timeoutMs}ms）`)), this.timeoutMs);
    });
    try {
      return await Promise.race([res.json(), timeoutPromise]);
    } catch (error) {
      if (error?.name === 'AbortError' || String(error?.message ?? '').includes('超时')) {
        throw new Error(`bilibili 响应超时（${this.timeoutMs}ms）`);
      }
      if (res.status === 412) throw new Error('bilibili 风控拦截（HTTP 412，疑似频次过高或 IP 被限），稍后重试或配置登录 cookie');
      throw new Error(`bilibili 响应不是 JSON（HTTP ${res.status}），可能是风控页`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * GET JSON API（code!=0 抛错）。对 -509/-352/-412/HTTP412 做一次退避重试。
   * 所有请求经串行队列：节流间隔不竞态，且 body 读取也在锁内。
   */
  async getJson(path, { headers = {}, wbiParams = null } = {}) {
    const attempt = async () => {
      let url = `${API}${path}`;
      if (wbiParams) {
        const { imgKey, subKey } = await this.ensureWbiKeys();
        url += (url.includes('?') ? '&' : '?') + encWbi(wbiParams, imgKey, subKey);
      }
      let res;
      try {
        res = await this.raw(url, headers);
      } catch (error) {
        // 网络层瞬态错误（DNS/TCP/边缘 IP 不可达）不占风控退避，短退避直接重试
        if (isTransientNetworkError(error)) {
          error.retryable = true;
          error.network = true;
        }
        throw error;
      }
      let data;
      try {
        data = await this.readJson(res);
      } catch (error) {
        const msg = String(error?.message ?? error);
        const risky = msg.includes('412') || msg.includes('风控');
        if (risky) throw Object.assign(error, { retryable: true });
        throw error;
      }
      if (data.code !== 0) {
        const err = apiError(data.code, data.message);
        if (data.code === -509 || data.code === -352 || data.code === -412) err.retryable = true;
        throw err;
      }
      return data;
    };

    const run = async () => {
      try {
        const result = await attempt();
        // AIMD：连续成功缓慢回落节流间隔与网络重试计数
        if (this.minIntervalMs > 350) this.minIntervalMs = Math.max(300, this.minIntervalMs * 0.8);
        this.netRetries = 0;
        return result;
      } catch (error) {
        if (!error?.retryable) throw error;
        if (error.network) {
          // 网络瞬态：短退避（500ms+抖动）撞下一个连接；最多再试 2 次
          this.netRetries = (this.netRetries ?? 0) + 1;
          if (this.netRetries > 2) {
            this.netRetries = 0;
            throw new Error('bilibili 网络连接反复失败（DNS/边缘节点不可达），请稍后重试；本机网络或代理可能异常');
          }
          this.log('warn', `网络瞬态（${oneLine(error.message, 80)}），500ms 后重试（第 ${this.netRetries}/2 次）`);
          await sleep(500 + Math.floor(Math.random() * 300));
          return run();
        }
        // AIMD：遇风控/限频先翻倍节流间隔（上限 8s），再指数退避（2s→5s）+ 抖动重试一次
        this.minIntervalMs = Math.min(8000, Math.max(1000, this.minIntervalMs * 2));
        const backoff = this.retryRound === 1 ? 2000 : 5000;
        this.retryRound = this.retryRound === 1 ? 2 : 1;
        const jitter = Math.floor(Math.random() * 800);
        this.log('warn', `风控/限频（${oneLine(error.message, 100)}），节流升至 ${Math.round(this.minIntervalMs)}ms，退避 ${backoff + jitter}ms 后重试`);
        await sleep(backoff + jitter);
        const result = await attempt();
        this.retryRound = 1; // 成功后重置
        return result;
      }
    };

    // 串行队列：上一个请求（含 body 读取）完成后才开始下一个
    const job = this.queue.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastRequestAt);
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      return run();
    });
    // 队列自身不因单次失败断裂
    this.queue = job.then(() => undefined, () => undefined);
    return job;
  }

  // ---------- 高层语义 API ----------

  /** 综合搜索视频。keyword 必填；page 从 1 起。 */
  async searchVideos(keyword, page = 1, maxResults = 20) {
    const kw = String(keyword ?? '').trim();
    if (kw === '') throw new Error('搜索关键词不能为空');
    const pg = Math.max(1, Math.floor(Number(page) || 1));
    await this.ensureSpi();
    const data = await this.getJson(
      `/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(kw)}&page=${pg}`,
      { headers: { referer: 'https://search.bilibili.com/' } },
    );
    const items = data.data?.result ?? [];
    const videos = items.slice(0, maxResults).map((v) => ({
      bvid: v.bvid,
      aid: v.aid,
      title: stripHtml(v.title),
      url: `https://www.bilibili.com/video/${v.bvid}`,
      author: v.author,
      mid: v.mid,
      duration: v.duration, // "mm:ss"
      pubdate: isoOf(v.pubdate),
      play: v.play,
      danmaku: v.video_review,
      favorites: v.favorite,
      description: v.description ? oneLine(v.description, LIMITS.searchSnippet) : '',
    }));
    return { kind: 'video', query: kw, page: pg, total: data.data?.numResults ?? 0, numPages: data.data?.numPages, count: videos.length, videos };
  }

  /** 搜索专栏（文章）。 */
  async searchArticles(keyword, page = 1, maxResults = 20) {
    const kw = String(keyword ?? '').trim();
    if (kw === '') throw new Error('搜索关键词不能为空');
    const pg = Math.max(1, Math.floor(Number(page) || 1));
    await this.ensureSpi();
    const data = await this.getJson(
      `/x/web-interface/search/type?search_type=article&keyword=${encodeURIComponent(kw)}&page=${pg}`,
      { headers: { referer: 'https://search.bilibili.com/', origin: 'https://search.bilibili.com' } },
    );
    const items = data.data?.result ?? [];
    const articles = items.slice(0, maxResults).map((a) => ({
      cvid: a.id,
      url: `https://www.bilibili.com/read/cv${a.id}`,
      title: stripHtml(a.title),
      desc: a.desc ? oneLine(a.desc, LIMITS.searchSnippet) : '',
      author: a.author,
      mid: a.mid,
      category: a.category_name,
      pubdate: isoOf(a.pubdate),
      view: a.view,
      like: a.like,
      reply: a.reply,
    }));
    return { kind: 'article', query: kw, page: pg, total: data.data?.numResults ?? 0, numPages: data.data?.numPages, count: articles.length, articles };
  }

  /**
   * 解析输入（bvid / av号 / URL / cv号 / 专栏 URL）→ { kind, id }。
   * 纯数字视为专栏 cv id（与 B 站 URL 语义一致：/read/cv 数字唯一出现在专栏）。
   */
  static parseTarget(input) {
    const s = String(input ?? '').trim().slice(0, 500); // 超长输入防御
    if (s === '') return { kind: 'unknown', id: '' };
    const bvUrl = s.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/);
    if (bvUrl) return { kind: 'video', id: bvUrl[1] };
    const avUrl = s.match(/bilibili\.com\/video\/av(\d+)/i);
    if (avUrl) return { kind: 'video', id: `av${avUrl[1]}` };
    const cvUrl = s.match(/bilibili\.com\/read\/cv(\d+)/i);
    if (cvUrl) return { kind: 'article', id: cvUrl[1] };
    if (/^BV[0-9A-Za-z]{10}$/.test(s)) return { kind: 'video', id: s };
    if (/^av(\d+)$/i.test(s)) return { kind: 'video', id: s.toLowerCase() };
    if (/^cv(\d+)$/i.test(s)) return { kind: 'article', id: s.slice(2) };
    if (/^\d+$/.test(s)) return { kind: 'article', id: s };
    return { kind: 'unknown', id: s };
  }

  /** 视频完整信息：详情 + 标签 + 分P。 */
  async readVideo(target) {
    const { kind, id } = BiliClient.parseTarget(target);
    if (kind !== 'video') throw new Error(`不是视频标识（期望 BV号/av号/视频URL）：${oneLine(target, 120)}`);
    const by = /^av/.test(id) ? `aid=${id.slice(2)}` : `bvid=${id}`;
    const view = await this.getJson(`/x/web-interface/view?${by}`);
    const v = view.data;
    let tags = [];
    try {
      const t = await this.getJson(`/x/tag/archive/tags?aid=${v.aid}`);
      tags = (t.data ?? []).map((x) => x.tag_name).slice(0, 20);
    } catch (error) {
      this.log('warn', `tags failed: ${oneLine(String(error?.message ?? error), 100)}`);
    }
    const allPages = v.pages ?? [];
    const pages = allPages.slice(0, LIMITS.maxPages).map((p) => ({
      page: p.page,
      part: p.part,
      duration: p.duration,
      cid: p.cid,
    }));
    const desc = String(v.desc ?? '');
    return {
      bvid: v.bvid,
      aid: v.aid,
      cid: v.cid,
      title: v.title,
      url: `https://www.bilibili.com/video/${v.bvid}`,
      desc: desc.slice(0, LIMITS.videoDesc),
      descTruncated: desc.length > LIMITS.videoDesc,
      descTotalChars: desc.length,
      owner: { name: v.owner?.name, mid: v.owner?.mid, face: v.owner?.face },
      pubdate: isoOf(v.pubdate || v.ctime),
      durationSec: v.duration,
      tid: v.tid,
      tname: v.tname,
      stat: {
        view: v.stat?.view, danmaku: v.stat?.danmaku, reply: v.stat?.reply,
        favorite: v.stat?.favorite, coin: v.stat?.coin, share: v.stat?.share,
        like: v.stat?.like, dislike: v.stat?.dislike,
      },
      tags,
      pages,
      pagesTotal: allPages.length,
      honor: (v.honor_reply?.honor ?? []).map((h) => h.desc).slice(0, 5),
    };
  }

  /** 专栏正文（Quill Delta content → 纯文本+图片清单）。 */
  async readArticle(target) {
    const { kind, id } = BiliClient.parseTarget(target);
    if (kind !== 'article') throw new Error(`不是专栏标识（期望 cv号/专栏URL）：${oneLine(target, 120)}`);
    await this.ensureSpi();
    const data = await this.getJson('/x/article/view', { wbiParams: { id } });
    const a = data.data;
    const { text: fullText, images, imagesTotal } = deltaToText(a.content, { maxImages: LIMITS.maxImages });
    return {
      cvid: a.id,
      title: a.title,
      url: `https://www.bilibili.com/read/cv${a.id}`,
      author: { name: a.author?.name, mid: a.author?.mid, face: a.author?.face },
      publishTime: isoOf(a.publish_time),
      words: a.words,
      readCount: a.stats?.view,
      like: a.stats?.like,
      reply: a.stats?.reply,
      coin: a.stats?.coin,
      favorite: a.stats?.favorite,
      share: a.stats?.share,
      categories: (a.categories ?? []).map((c) => c.name ?? c.category_name).filter(Boolean),
      tags: a.keywords?.split(',').map((s) => s.trim()).filter(Boolean) ?? [],
      summary: String(a.summary ?? '').slice(0, LIMITS.summary),
      text: fullText.slice(0, LIMITS.articleText),
      textTruncated: fullText.length > LIMITS.articleText,
      textTotalChars: fullText.length,
      images,
      imagesTotal,
    };
  }

  /**
   * 评论（/x/v2/reply/main）。oid=aid，type=1 视频 / 12 专栏。
   * 单页语义（B 站单页最多 20 条）：mode=3 热门为空时回退 mode=2；置顶评论并入头部。
   */
  async readComments(target, { limit = 20 } = {}) {
    let oid;
    let kindName;
    const { kind, id } = BiliClient.parseTarget(target);
    if (kind === 'video') {
      const by = /^av/.test(id) ? `aid=${id.slice(2)}` : `bvid=${id}`;
      const view = await this.getJson(`/x/web-interface/view?${by}`);
      oid = view.data?.aid;
      kindName = 1;
    } else if (kind === 'article') {
      oid = Number(id);
      kindName = 12;
    } else {
      throw new Error(`无法识别目标（期望 BV/av/cv 号或 URL）：${oneLine(target, 120)}`);
    }
    if (!oid) throw new Error('未能解析出 oid');
    const size = Math.max(1, Math.min(20, limit));
    let data = await this.getJson(`/x/v2/reply/main?type=${kindName}&oid=${oid}&mode=3`);
    let replies = data.data?.replies ?? [];
    if (replies.length === 0) {
      // mode=3（热门）对部分视频匿名间歇返回空，回退 mode=2（时间）
      this.log('info', 'mode=3 空结果，回退 mode=2');
      data = await this.getJson(`/x/v2/reply/main?type=${kindName}&oid=${oid}&mode=2`);
      replies = data.data?.replies ?? [];
    }
    const top = data.data?.top?.upper ?? data.data?.top_replies?.[0] ?? null;
    const cursor = data.data?.cursor ?? {};
    const seen = new Set();
    const formatReply = (r, isTop = false) => ({
      uname: r.member?.uname,
      content: r.content?.message,
      like: r.like,
      ctime: isoOf(r.ctime),
      location: r.reply_control?.location ?? r.content?.location,
      top: isTop,
      replies: (r.replies ?? []).slice(0, 3).map((sub) => formatReply(sub)),
    });
    const merged = [];
    if (top) { merged.push(formatReply(top, true)); seen.add(top.rpid); }
    for (const r of replies) {
      if (seen.has(r.rpid)) continue;
      merged.push(formatReply(r));
    }
    const slice = merged.slice(0, size);
    return {
      oid,
      type: kindName,
      total: cursor.all_count ?? 0,
      count: slice.length,
      comments: slice,
    };
  }
}
