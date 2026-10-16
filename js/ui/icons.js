/* =========================================================
   js/ui/icons.js
   線画SVGアイコン（design.md 9.17、architecture.md 4.2・14.1）。

   描き方の約束（design 9.17）：24×24 の枠、線の太さ 1.75、線の端と角は丸め、塗りなし、色は文字色に追従。
   見た目（太さ・大きさ）は css/components.css の .icon が受け持つ。ここでは「形」だけを持つ。

   なぜ innerHTML を使わないのか：
   architecture 14.1 では「固定のSVG文字列だけは innerHTML 可」としているが、
   形のデータ（線の座標）から createElementNS で組み立てれば innerHTML 自体が不要になる。
   コード全体で innerHTML が0件になり、reviewer の検索（14.1）も「0件」で確認が済む。
   形のデータはすべてこのファイルの固定値で、利用者の入力は混ざらない。
   ========================================================= */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * アイコンの形。['path', 'd の値'] または ['circle', cx, cy, r] または ['rect', x, y, w, h, rx] の並び。
 * 一覧・グラフ・歯車は index.html のタブバーと同じ形（同じアイコンが場所で違って見えないように）。
 */
const SHAPES = {
  // タブバー（index.html と同じ形）
  list: [['path', 'M9 6h11M9 12h11M9 18h11'], ['path', 'M4.5 6h.01M4.5 12h.01M4.5 18h.01']],
  chart: [['path', 'M4 4v16h16'], ['path', 'M8 15l3.5-4 3 2.5L19 8']],
  gear: [
    ['circle', 12, 12, 3],
    ['path', 'M12 2.75v2.5M12 18.75v2.5M2.75 12h2.5M18.75 12h2.5M5.46 5.46l1.77 1.77M16.77 16.77l1.77 1.77M5.46 18.54l1.77-1.77M16.77 7.23l1.77-1.77'],
    ['circle', 12, 12, 6.25],
  ],
  // 操作
  plus: [['path', 'M12 5v14M5 12h14']],
  chevronLeft: [['path', 'M15 4.5L7.5 12l7.5 7.5']], // ‹（戻る）
  chevronRight: [['path', 'M9.5 6l6 6-6 6']],        // ›（次へ）
  close: [['path', 'M6.5 6.5l11 11M17.5 6.5l-11 11']], // ×
  check: [['path', 'M5 12.5l4.5 4.5L19 7']],          // ✓
  filter: [['path', 'M4 5.5h16l-6.25 7.25V19l-3.5-1.75v-4.5L4 5.5z']], // 絞り込み（じょうご）
  search: [['circle', 11, 11, 6.5], ['path', 'M16 16l4.5 4.5']],
  share: [['path', 'M12 3.5v11'], ['path', 'M8 7.5l4-4 4 4'], ['path', 'M8.5 10.5H6v10h12v-10h-2.5']], // iOS の共有
  moreVertical: [['circle', 12, 5.5, 1], ['circle', 12, 12, 1], ['circle', 12, 18.5, 1]],           // Android のメニュー
  // 状態
  warning: [['path', 'M12 3.75L2.75 19.75h18.5L12 3.75z'], ['path', 'M12 9.75v4.5'], ['path', 'M12 17.25h.01']], // ⚠
  spinner: [['path', 'M12 3.5a8.5 8.5 0 1 1-8.5 8.5']], // 回転（4分の3の円。CSS で回す）
  sync: [['path', 'M19.5 12a7.5 7.5 0 0 1-13.1 5'], ['path', 'M4.5 12a7.5 7.5 0 0 1 13.1-5'], ['path', 'M18 3.5V7h-3.5'], ['path', 'M6 20.5V17h3.5']],
  // 記録まわり
  photo: [['rect', 3, 5, 18, 14, 2], ['circle', 8.5, 10, 1.5], ['path', 'M20.5 16l-4.75-4.75L8 19']],
  pencil: [['path', 'M4.5 19.5h4l10.25-10.25-4-4L4.5 15.5v4z'], ['path', 'M13 7l4 4']], // 入力途中の下書き
  notebook: [['rect', 5, 3, 14, 18, 2], ['path', 'M9 3v18'], ['path', 'M12.5 8h3.5M12.5 12h3.5']], // 空状態（帳面）
  minusCircle: [['circle', 12, 12, 8.5], ['path', 'M8 12h8']], // ⊖（選択肢の削除）
  grip: [['path', 'M5 9h14M5 12h14M5 15h14']],                 // ≡（並べ替えのつまみ）
};

/** 使えるアイコンの名前（確認用ページで一覧にするため） */
export const ICON_NAMES = Object.freeze(Object.keys(SHAPES));

/** 形のデータ1つから SVG の要素を作る */
function shapeToElement(shape) {
  const [type, ...v] = shape;
  const el = document.createElementNS(SVG_NS, type);
  if (type === 'path') {
    el.setAttribute('d', v[0]);
  } else if (type === 'circle') {
    el.setAttribute('cx', v[0]); el.setAttribute('cy', v[1]); el.setAttribute('r', v[2]);
  } else if (type === 'rect') {
    el.setAttribute('x', v[0]); el.setAttribute('y', v[1]);
    el.setAttribute('width', v[2]); el.setAttribute('height', v[3]);
    if (v[4]) el.setAttribute('rx', v[4]);
  }
  return el;
}

/**
 * 線画アイコンの <svg> を作る。
 * 文字ラベルと一緒に置く（「‹ 一覧」「＋ 新規エントリー」など）ときは label を渡さない＝読み上げない（飾り）。
 * アイコンだけで意味を伝えるときは label を渡す（ただし押せるアイコンは、ボタン側に aria-label を付ける方がよい）。
 * @param {string} name SHAPES の名前（例 'chevronLeft'）
 * @param {{ size?: 'xs'|'sm'|'md'|'lg', className?: string, label?: string }} [opts]
 *   size：xs 16px（エラー文の⚠・チップの✓）／sm 20px（新規エントリーの＋）／md 24px（標準）／lg 40px（空状態）
 * @returns {SVGSVGElement}
 */
export function icon(name, { size = 'md', className = '', label = '' } = {}) {
  const shapes = SHAPES[name];
  if (!shapes) throw new Error(`icon(): 未登録のアイコン ${name}`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon icon--${size} icon--${name}${className ? ` ${className}` : ''}`);
  // SVG がキーボードのフォーカスを受け取らないように（古い Edge/IE の挙動対策）
  svg.setAttribute('focusable', 'false');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  for (const s of shapes) svg.append(shapeToElement(s));
  return svg;
}
