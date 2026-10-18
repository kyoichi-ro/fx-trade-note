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
   ・RL-06 バージョンの上げ忘れ（T-33：T-31 の S-02）：「最後に公開した状態」と比べて、アプリのファイル（SHELL_FILES の全ファイルと
           sw.js）の中身が1つでも変わっているのに APP_VERSION が同じなら不合格。Service Worker は sw.js の中身が変わったときだけ
           新しい版を入れるので、上げ忘れると直した版がスマホに届かない（キャッシュ優先のため、開き直しても古いまま）。
           比べる相手（基準）は次の順に決める：
             ① 今のブランチの追跡先（@{upstream}。ふだんは origin/main）＝ GitHub に push した最後の状態＝公開中の版。
                公開前に何回コミットしても、公開中の版と APP_VERSION が違っていれば合格（版を上げたあとの手直しも同じ版に含めてよい）
             ② 追跡先がないとき（push したことがない・別の場所へ複製した）：js/config.js の APP_VERSION の行を最後に変えたコミット。
                「版を上げたあと、さらにファイルを直したのに上げていない」を見つける
           比べるのは作業中のファイル（コミット前の変更も含む）。git が使えない・リポジトリでない・ブラウザ（git を動かせない）では
           この1件だけスキップする（ほかのテストは止めない）
   ・RL-07 RL-06 の合否の決め方（judgeVersionBump）を、決まった入力で確かめる（git がなくても動く）
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

/* ---------------------------------------------------------
   RL-06 バージョンの上げ忘れ（git で「最後に公開した状態」と比べる。Node.js だけ）
   --------------------------------------------------------- */

/**
 * RL-06 の合否を決める（git を使わない純粋な関数。RL-07 で確かめる）。
 * @param {{ changedFiles: string[], baseVersion: (string|null), currentVersion: (string|null) }} p
 *   changedFiles   … 基準と比べて中身が変わったアプリのファイル（ルートからの相対パス）
 *   baseVersion    … 基準の APP_VERSION（基準に config.js がない・読めないときは null）
 *   currentVersion … 今の APP_VERSION
 * @returns {{ pass: boolean, reason: 'unchanged'|'bumped'|'no-base-version'|'forgot' }}
 *   'forgot' のときだけ不合格（ファイルが変わったのに版が同じ）
 */
export function judgeVersionBump({ changedFiles, baseVersion, currentVersion }) {
  if (changedFiles.length === 0) return { pass: true, reason: 'unchanged' };
  // 基準に版の書き込みがない（初めての公開より前など）ときは、比べられないので合格にする
  if (baseVersion == null) return { pass: true, reason: 'no-base-version' };
  if (currentVersion !== baseVersion) return { pass: true, reason: 'bumped' };
  return { pass: false, reason: 'forgot' };
}

/** git を実行して標準出力を返す（失敗したら null）。プロジェクトのルートで動かす */
async function git(args) {
  const { execFile } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cwd = fileURLToPath(projectUrl(''));
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/**
 * 比べる相手（基準）のコミットを決める（冒頭の RL-06 の説明の ① → ②）。
 * @returns {Promise<{ commit: string, label: string } | null>} 決められなければ null
 */
async function findReleaseBase() {
  const upstream = await git(['rev-parse', '--verify', '--quiet', '@{upstream}']);
  if (upstream && upstream.trim()) {
    const name = (await git(['rev-parse', '--abbrev-ref', '@{upstream}'])) || '';
    return { commit: upstream.trim(), label: `追跡先 ${name.trim() || '@{upstream}'}` };
  }
  // -G：その行の追加・削除を含むコミットだけを選ぶ（コメントの書き換えでは選ばれないよう、行の書き出しまで指定する）
  const last = await git(['log', '-1', '--format=%H', '-G', "^export const APP_VERSION = '", '--', 'js/config.js']);
  if (last && last.trim()) return { commit: last.trim(), label: `APP_VERSION を最後に変えたコミット ${last.trim().slice(0, 7)}` };
  return null;
}

/**
 * RL-06 の本体。git が使えない環境では { skipped: true } を返す（runner.js がスキップとして数える）。
 */
async function checkVersionBump() {
  const skip = (why) => ({ actual: `スキップ（${why}）`, pass: false, skipped: true, skipReason: 'git' });
  if (!IS_NODE) return skip('ブラウザでは git を使えないため。node tests/run-node.mjs で確かめます');
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.trim() !== 'true') return skip('git が使えない、または git のリポジトリではないため');
  const base = await findReleaseBase();
  if (!base) return skip('比べる相手のコミットが見つからないため');

  const { files, version: currentVersion } = await loadSw();
  if (!files) return { actual: 'SHELL_FILES が見つかりません', pass: false };
  const appFiles = [...new Set(['sw.js', ...files.map(fromShell)])];
  // 作業中のファイル（コミット前の変更を含む）と基準のコミットを比べる。中身が同じなら名前は出ない
  const diff = await git(['diff', '--name-only', base.commit, '--', ...appFiles]);
  if (diff === null) return skip('git diff を実行できなかったため');
  const changedFiles = diff.split('\n').map((s) => s.trim()).filter(Boolean);
  const baseConfig = await git(['show', `${base.commit}:js/config.js`]);
  const baseVersion = baseConfig === null ? null : parseConfigVersion(baseConfig);
  const configVersion = parseConfigVersion(await readText('js/config.js'));

  const r = judgeVersionBump({ changedFiles, baseVersion, currentVersion: configVersion });
  const head = `基準：${base.label}（APP_VERSION ${show(baseVersion)}）／今 ${show(configVersion)}`;
  const listed = changedFiles.length > 3 ? `${changedFiles.slice(0, 3).join('・')} ほか${changedFiles.length - 3}件` : changedFiles.join('・');
  if (r.reason === 'unchanged') return { actual: `${head}／アプリのファイルの変更なし`, pass: true };
  if (r.reason === 'no-base-version') return { actual: `${head}／基準に APP_VERSION がないため比べない`, pass: true };
  if (r.reason === 'bumped') return { actual: `${head}／変更 ${changedFiles.length}件・版は上げてある`, pass: true };
  // sw.js と config.js の値の食い違いは RL-01 が見つけるので、ここでは config.js の値で判定している
  return { actual: `${head}／ファイルが変わっています（${listed}）。js/config.js と sw.js の APP_VERSION を上げてください`, pass: false };
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

    t('RL-06', 'アプリのファイルを変えたら APP_VERSION も上げてある', 'git：最後に公開した状態（追跡先。なければ APP_VERSION を最後に変えたコミット）と、SHELL_FILES の全ファイル・sw.js を比べる',
      '中身が変わったファイルがあれば、APP_VERSION が基準と違う（git が使えない環境・ブラウザではスキップ）', () => checkVersionBump()),

    t('RL-07', 'RL-06 の合否の決め方', '変更なし・版同じ／変更あり・版上げ／変更あり・版同じ／変更あり・基準に版なし',
      '合格／合格／不合格（上げ忘れ）／合格', () => {
        const cases = [
          [{ changedFiles: [], baseVersion: '0.2.0', currentVersion: '0.2.0' }, true, 'unchanged'],
          [{ changedFiles: ['js/app.js'], baseVersion: '0.1.0', currentVersion: '0.2.0' }, true, 'bumped'],
          [{ changedFiles: ['css/base.css', 'sw.js'], baseVersion: '0.2.0', currentVersion: '0.2.0' }, false, 'forgot'],
          [{ changedFiles: ['js/app.js'], baseVersion: null, currentVersion: '0.2.0' }, true, 'no-base-version'],
        ];
        const got = cases.map(([input]) => judgeVersionBump(input));
        const ok = cases.every(([, pass, reason], i) => got[i].pass === pass && got[i].reason === reason);
        return { actual: got.map((r) => `${r.pass ? '合格' : '不合格'}（${r.reason}）`).join('／'), pass: ok };
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
