/* =========================================================
   tests/release.test.js
   リリース確認（T-28。architecture 12.2・12.3・13.2「リリース確認」・18.4）。公開の前に、Service Worker（sw.js）の
   書き忘れ・食い違いを自動で見つける。

   ・RL-01 バージョンの一致：sw.js と js/config.js の APP_VERSION が同じ値か
   ・RL-02 一覧の書き方：SHELL_FILES がすべて ./ で始まる相対パス・重複なし・tests/ を含まない・キャッシュ名の接頭辞が fxnote-
   ・RL-03 一覧のファイルが実在するか（消したファイルを一覧に残すと、インストールが丸ごと失敗してオフラインで開けなくなるため）
   ・RL-04 index.html・manifest.json・CSS・JS（import と画面の遅延読み込み import()）からたどれるファイルが、全部一覧にあるか
   ・RL-05 css/・js/・icons/ の全ファイルが一覧にあるか（Node.js ではフォルダの中身と突き合わせる。
           ブラウザはフォルダの中身を読めないので RL-04 と同じ「たどり」で確かめる）
   ・SU-xx Service Worker を登録するかの判定（localhost では ?sw=1 のときだけ：architecture 18.4）と、更新の確認の間隔（1時間）

   ファイルの読み方：Node.js はファイルを直接読み、ブラウザ（tests/index.html）は同じサーバーから fetch で読む。
   sw.js は Service Worker の中でしか動かないため、実行せずに文字として読み、SHELL_FILES の '…' を取り出す
   （sw.js 側は「1行に1ファイル、'…' で囲む」書き方にしてある）。

   ID：RL-xx（リリース確認）、SU-xx（Service Worker の登録と更新）
   ========================================================= */
import { swMode, isUpdateCheckDue, UPDATE_CHECK_INTERVAL_MS } from '../js/sw-update.js';
import { show } from './helpers.js';

const CATEGORY = 'リリース確認';
const t = (id, title, input, expected, run) => ({ category: CATEGORY, id, title, input, expected, run });

/** Node.js で動いているか（ブラウザには window がある） */
const IS_NODE = typeof window === 'undefined';

/** プロジェクトのルート（この tests/ フォルダの1つ上）からの相対パスを URL にする */
const projectUrl = (path) => new URL(`../${path}`, import.meta.url);

/** フォルダを中身と突き合わせるときに無視するファイル（Windows・OneDrive が勝手に作る：.gitignore と同じ） */
const IGNORED_NAMES = new Set(['Thumbs.db', 'desktop.ini']);

/* ---------------------------------------------------------
   ファイルの読み方（Node.js とブラウザで切り替える）
   --------------------------------------------------------- */

/** ファイルの中身（文字）を読む */
async function readText(path) {
  if (IS_NODE) {
    const fs = await import('node:fs/promises');
    return fs.readFile(projectUrl(path), 'utf8');
  }
  // cache: 'no-store' … 直したばかりのファイルを確かめたいので、ブラウザの一時保存を使わない
  const res = await fetch(projectUrl(path), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} を読めません（${res.status}）`);
  return res.text();
}

/** ファイルがあるか */
async function exists(path) {
  if (IS_NODE) {
    const fs = await import('node:fs/promises');
    try {
      return (await fs.stat(projectUrl(path))).isFile();
    } catch (e) {
      return false;
    }
  }
  const res = await fetch(projectUrl(path), { method: 'HEAD', cache: 'no-store' });
  return res.ok;
}

/** フォルダの中の全ファイル（下のフォルダも含む）を、ルートからの相対パスで返す（Node.js だけ） */
async function listFilesNode(dir) {
  const fs = await import('node:fs/promises');
  const nodePath = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(projectUrl(''));
  const entries = await fs.readdir(projectUrl(dir), { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && !IGNORED_NAMES.has(e.name))
    // parentPath（新しい Node）／path（古い Node）は入っているフォルダの絶対パス。ルートからの相対に直し、区切りを / にそろえる（Windows は \ のため）
    .map((e) => nodePath.relative(root, nodePath.join(e.parentPath || e.path, e.name)).split(nodePath.sep).join('/'));
}

/* ---------------------------------------------------------
   sw.js・config.js の読み取り
   --------------------------------------------------------- */

/** sw.js の文字から APP_VERSION・CACHE_PREFIX・SHELL_FILES を取り出す */
export function parseSw(text) {
  const version = (text.match(/const APP_VERSION = '([^']*)'/) || [])[1] || null;
  const prefix = (text.match(/const CACHE_PREFIX = '([^']*)'/) || [])[1] || null;
  const block = (text.match(/const SHELL_FILES = \[([\s\S]*?)\];/) || [])[1];
  const files = block === undefined ? null : [...stripComments(block).matchAll(/'([^']*)'/g)].map((m) => m[1]);
  return { version, prefix, files };
}

/** config.js の文字から APP_VERSION を取り出す */
function parseConfigVersion(text) {
  return (text.match(/export const APP_VERSION = '([^']*)'/) || [])[1] || null;
}

/**
 * JS・CSS のコメントを取り除く（説明文の中に書いた「import('./…')」などを、本物の読み込みと間違えないため）。
 * 行コメントは「行頭か空白のあとの //」だけを対象にする（文字列の中の 'https://…' を消さないため）。
 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** './js/app.js' → 'js/app.js'（ルートからの相対パス） */
const fromShell = (p) => p.replace(/^\.\//, '');

/* ---------------------------------------------------------
   参照のたどり（index.html から読み込まれるファイルを全部集める）
   --------------------------------------------------------- */

/** from（ルートからの相対パスのファイル）の中で書かれた相対の指定 spec を、ルートからの相対パスに直す。外部・特殊なものは null */
function resolveRef(spec, from) {
  if (/^(?:[a-z]+:|\/\/|#)/i.test(spec)) return null; // https: data: blob: mailto: #… は対象外
  const base = new URL(from, 'http://app.invalid/');
  const url = new URL(spec, base);
  return url.origin === base.origin ? decodeURIComponent(url.pathname).replace(/^\//, '') : null;
}

/** ファイルの中から、読み込んでいる別のファイルの指定（相対パス）を取り出す */
function refsIn(path, text) {
  if (path.endsWith('.html')) {
    // <script src>・<link href> など。HTML のコメント <!-- --> の中は除く
    const html = text.replace(/<!--[\s\S]*?-->/g, '');
    return [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  }
  if (path.endsWith('.json')) {
    const json = JSON.parse(text);
    return (json.icons || []).map((i) => i.src);
  }
  if (path.endsWith('.css')) {
    return [...stripComments(text).matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]);
  }
  if (path.endsWith('.js')) {
    const code = stripComments(text);
    return [
      ...[...code.matchAll(/\b(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]), // import … from './x.js'
      ...[...code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),                          // import './x.js'
      ...[...code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),                   // import('./screens/x.js')
    ];
  }
  return [];
}

/** index.html から始めて、読み込まれるファイルを全部たどる（ルートからの相対パスの並び） */
async function crawlFromIndex() {
  const seen = new Set();
  const queue = ['index.html'];
  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    if (!/\.(?:html|json|css|js)$/.test(path)) continue; // 画像などは中を読まない
    if (!(await exists(path))) continue; // 無いファイルは RL-03 ではなく「一覧に無い」で見つかる
    const text = await readText(path);
    for (const spec of refsIn(path, text)) {
      const ref = resolveRef(spec, path);
      if (ref && !seen.has(ref)) queue.push(ref);
    }
  }
  return [...seen].sort();
}

/* ---------------------------------------------------------
   テストの定義
   --------------------------------------------------------- */

/** 名前と合否の並びから結果を作る（不合格のものだけ中身を出す） */
function verdict(checks) {
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) return { actual: `確認${checks.length}項目すべて一致`, pass: true };
  return { actual: failed.map(([label, , detail]) => `×${label}（${show(detail)}）`).join('／'), pass: false };
}

async function loadSw() {
  return parseSw(await readText('sw.js'));
}

export function collectReleaseTests() {
  return [
    t('RL-01', 'sw.js と config.js のバージョンが一致', 'sw.js・js/config.js の APP_VERSION', '同じ値', async () => {
      const sw = await loadSw();
      const config = parseConfigVersion(await readText('js/config.js'));
      return {
        actual: `sw.js ${show(sw.version)}／config.js ${show(config)}`,
        pass: sw.version !== null && sw.version === config,
      };
    }),

    t('RL-02', 'キャッシュの一覧の書き方', 'sw.js の SHELL_FILES・CACHE_PREFIX',
      'すべて ./ で始まる相対パス・重複なし・tests/ を含まない・index.html と manifest.json を含む・接頭辞 fxnote-', async () => {
        const { files, prefix } = await loadSw();
        if (!files) return { actual: 'SHELL_FILES が見つかりません', pass: false };
        const notRelative = files.filter((f) => !f.startsWith('./') || f.startsWith('./tests/') || f.includes('..'));
        const dup = files.filter((f, i) => files.indexOf(f) !== i);
        return verdict([
          ['相対パス・tests/ なし', notRelative.length === 0, notRelative],
          ['重複なし', dup.length === 0, dup],
          ['index.html を含む', files.includes('./index.html'), files.length],
          ['manifest.json を含む', files.includes('./manifest.json'), files.length],
          ['接頭辞 fxnote-', prefix === 'fxnote-', prefix],
        ]);
      }),

    t('RL-03', '一覧のファイルがすべて実在する', 'SHELL_FILES の各ファイル', '無いファイル 0件', async () => {
      const { files } = await loadSw();
      if (!files) return { actual: 'SHELL_FILES が見つかりません', pass: false };
      const missing = [];
      for (const f of files) {
        if (!(await exists(fromShell(f)))) missing.push(f);
      }
      return { actual: missing.length === 0 ? `${files.length}件すべてあり` : `無い：${show(missing)}`, pass: missing.length === 0 };
    }),

    t('RL-04', '読み込まれるファイルが全部一覧にある', 'index.html から <script>・<link>・manifest のアイコン・CSS の url()・JS の import をたどる',
      '一覧に無いファイル 0件', async () => {
        const { files } = await loadSw();
        if (!files) return { actual: 'SHELL_FILES が見つかりません', pass: false };
        const listed = new Set(files.map(fromShell));
        const reached = await crawlFromIndex();
        const notListed = reached.filter((p) => !listed.has(p));
        return {
          actual: notListed.length === 0 ? `たどれた${reached.length}件すべて一覧にあり` : `一覧に無い：${show(notListed)}`,
          pass: notListed.length === 0,
        };
      }),

    t('RL-05', 'css/・js/・icons/ の全ファイルが一覧にある', 'フォルダの中身（Node.js）／参照のたどり（ブラウザ）と SHELL_FILES',
      '一覧に無いファイル 0件・一覧だけにあるファイル 0件', async () => {
        const { files } = await loadSw();
        if (!files) return { actual: 'SHELL_FILES が見つかりません', pass: false };
        const listed = files.map(fromShell);
        const real = IS_NODE
          ? ['index.html', 'manifest.json', ...(await listFilesNode('css')), ...(await listFilesNode('js')), ...(await listFilesNode('icons'))]
          : await crawlFromIndex();
        const notListed = real.filter((p) => !listed.includes(p));
        // 一覧だけにある（フォルダに無い）ものは、Node.js のときだけ確かめる（ブラウザのたどりでは使っていないファイルが出ないため）
        const onlyInList = IS_NODE ? listed.filter((p) => !real.includes(p)) : [];
        const how = IS_NODE ? 'フォルダの中身' : '参照のたどり（ブラウザはフォルダを読めないため）';
        const pass = notListed.length === 0 && onlyInList.length === 0;
        return {
          actual: pass
            ? `${how}の${real.length}件と一致`
            : `一覧に無い：${show(notListed)}／一覧だけにある：${show(onlyInList)}`,
          pass,
        };
      }),

    {
      category: CATEGORY, id: 'SU-01', title: '公開版（github.io）は常に登録する',
      input: 'hostname=ユーザー名.github.io（?sw の有無どちらも）', expected: "'register'",
      run: () => {
        const a = swMode({ hostname: 'example.github.io', search: '' });
        const b = swMode({ hostname: 'example.github.io', search: '?sw=0' });
        return { actual: `${show(a)}／${show(b)}`, pass: a === 'register' && b === 'register' };
      },
    },
    {
      category: CATEGORY, id: 'SU-02', title: '開発中（localhost）は ?sw=1 のときだけ登録する',
      input: 'localhost・127.0.0.1・[::1] で ?sw=1／なし／?sw=0／?x=1&sw=1', expected: '?sw=1 を含むときだけ register、それ以外は unregister',
      run: () => {
        const cases = [
          [{ hostname: 'localhost', search: '?sw=1' }, 'register'],
          [{ hostname: 'localhost', search: '' }, 'unregister'],
          [{ hostname: 'localhost', search: '?sw=0' }, 'unregister'],
          [{ hostname: '127.0.0.1', search: '?x=1&sw=1' }, 'register'],
          [{ hostname: '[::1]', search: '' }, 'unregister'],
        ];
        const wrong = cases.filter(([loc, want]) => swMode(loc) !== want).map(([loc]) => `${loc.hostname}${loc.search}`);
        return { actual: wrong.length === 0 ? `${cases.length}通りすべて一致` : `違う：${show(wrong)}`, pass: wrong.length === 0 };
      },
    },
    {
      category: CATEGORY, id: 'SU-03', title: '前面に戻ったときの更新の確認は1時間に1回まで',
      input: '前回から 59分59秒／60分／一度も確かめていない（0）', expected: 'false／true／true',
      run: () => {
        const now = 1_800_000_000_000;
        const a = isUpdateCheckDue(now - UPDATE_CHECK_INTERVAL_MS + 1000, now);
        const b = isUpdateCheckDue(now - UPDATE_CHECK_INTERVAL_MS, now);
        const c = isUpdateCheckDue(0, now);
        return { actual: `${a}／${b}／${c}`, pass: a === false && b === true && c === true };
      },
    },
  ];
}
