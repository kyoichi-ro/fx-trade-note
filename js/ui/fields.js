/* =========================================================
   js/ui/fields.js
   入力部品（design.md 8.5・9.2・9.3・9.4、14.1.8 の入力チェックの出し方）：
     ・フォーム行（ラベル左・値右）          numberRow / textRow / textareaRow / dateTimeRow / switchRow
     ・チェックの行（1つだけ選ぶ・iOS「設定」と同じ） checkRows（T-15 で追加：設定のテーマ）
     ・セグメント切替（買い/売り・デモ/本番） segment
     ・チップ選択（根拠・感情・タグなど）     chips
     ・エラー①・注意②の文（グループの直下） setGroupMessages（1行だけ作る messageLine も T-16 で出した）
   見た目は css/components.css。文字はすべて ui/dom.js の h() を通す（XSS 対策）。

   部品は「値の読み書き」だけを受け持ち、入力チェックの中身（E-xx・W-xx）は validate.js、
   文言は design.md 14章（画面ごと）に従って各画面が決める。
   ========================================================= */
import { h, uniqueId, addIdRef, removeIdRef } from './dom.js';
import { icon } from './icons.js';

/* ---------------------------------------------------------
   フォーム行（design 9.2）
   行全体を <label> にするので、行のどこを押しても入力欄にフォーカスが移る（小さな入力欄を狙わなくてよい）
   --------------------------------------------------------- */

/**
 * 数値の入力行（価格・ロット・SL/TP など）。
 * type="number" は端末で挙動が違うため使わず、type="text"＋inputmode="decimal"（小数点付きの数字キーボード）にする
 * （design 8.5）。全角数字などの直しは validate.js の normalizeNumberText が行う。
 * @param {{ label: string, name?: string, value?: string, unit?: string, placeholder?: string,
 *   enterkeyhint?: 'next'|'done', onInput?: Function, onBlur?: Function, inputmode?: string }} opts
 * @returns {{ row: HTMLLabelElement, input: HTMLInputElement }}
 */
export function numberRow({
  label, name = '', value = '', unit = '', placeholder = '', enterkeyhint = 'next', onInput, onBlur, inputmode = 'decimal',
}) {
  const input = h('input', {
    class: 'form-row__input num',
    type: 'text',
    inputmode,
    name: name || null,
    value,
    placeholder: placeholder || null,
    enterkeyhint,
    // 数字の欄では自動修正・自動の大文字化・入力候補が邪魔になるので止める
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
    onInput, onBlur,
  });
  const row = h('label', { class: 'form-row' },
    h('span', { class: 'form-row__label' }, label),
    input,
    unit ? h('span', { class: 'form-row__unit' }, unit) : null,
  );
  return { row, input };
}

/**
 * 文字の入力行（1行）。合言葉など。
 * @returns {{ row: HTMLLabelElement, input: HTMLInputElement }}
 */
export function textRow({ label, name = '', value = '', placeholder = '', type = 'text', enterkeyhint = 'next', onInput, onBlur }) {
  const input = h('input', {
    class: 'form-row__input', type, name: name || null, value, placeholder: placeholder || null, enterkeyhint, onInput, onBlur,
  });
  const row = h('label', { class: 'form-row' }, h('span', { class: 'form-row__label' }, label), input);
  return { row, input };
}

/**
 * メモ欄（左揃え・最低3行・入力に合わせて伸びる）。残りが少なくなったら残り文字数を出す（design 9.2）。
 * @param {{ label: string, name?: string, value?: string, maxLength?: number, warnAt?: number, onInput?: Function }} opts
 *   warnAt：残りがこの文字数以下になったら残り文字数を表示する
 * @returns {{ row: HTMLLabelElement, textarea: HTMLTextAreaElement }}
 */
export function textareaRow({ label, name = '', value = '', maxLength = 2000, warnAt = 200, onInput }) {
  const counterId = uniqueId('cnt');
  const counter = h('span', { class: 'form-row__counter num', id: counterId, 'aria-live': 'polite' });
  const textarea = h('textarea', {
    class: 'form-row__textarea', name: name || null, rows: '3', maxlength: String(maxLength), 'aria-describedby': counterId,
  });
  textarea.value = value; // value は属性ではなくプロパティで入れる（改行などもそのまま入る）

  const update = () => {
    // 入力に合わせて高さを伸ばす（field-sizing は iOS 16 で使えないため JS で合わせる）
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
    const rest = maxLength - textarea.value.length;
    counter.textContent = rest <= warnAt ? `残り${rest}文字` : '';
  };
  textarea.addEventListener('input', (e) => { update(); if (onInput) onInput(e); });
  // 画面に置かれてから高さを測る（置かれる前は scrollHeight が 0）
  requestAnimationFrame(update);

  const row = h('label', { class: 'form-row form-row--stacked' },
    h('span', { class: 'form-row__label' }, label), textarea, counter);
  return { row, textarea };
}

/**
 * 日時の行：iOS 標準の日時選択（type="datetime-local"）＋右に「今にする」（design 8.5）。
 * 中に「今にする」ボタンがあるので行全体を <label> にはせず、ラベルは for で入力欄と結ぶ。
 * 日本時間の文字との変換（architecture 6.6）は datetime.js の担当なので、ここでは値をそのまま扱う。
 * @param {{ label: string, name?: string, value?: string, onNow?: Function, onChange?: Function }} opts
 * @returns {{ row: HTMLDivElement, input: HTMLInputElement }}
 */
export function dateTimeRow({ label, name = '', value = '', onNow, onChange }) {
  const id = uniqueId('dt');
  const input = h('input', { class: 'form-row__input num', type: 'datetime-local', id, name: name || null, value, onChange });
  const row = h('div', { class: 'form-row' },
    h('label', { class: 'form-row__label', for: id }, label),
    input,
    onNow ? h('button', { type: 'button', class: 'btn btn--text form-row__action', onClick: onNow }, '今にする') : null,
  );
  return { row, input };
}

/**
 * オン/オフのスイッチの行（iOS と同じ形。design 9.2）。<input type="checkbox" role="switch"> の見た目を変える。
 * @param {{ label: string, name?: string, checked?: boolean, onChange?: Function }} opts
 * @returns {{ row: HTMLLabelElement, input: HTMLInputElement }}
 */
export function switchRow({ label, name = '', checked = false, onChange }) {
  const input = h('input', { class: 'switch__input', type: 'checkbox', role: 'switch', name: name || null, checked, onChange });
  const row = h('label', { class: 'form-row' },
    h('span', { class: 'form-row__label' }, label),
    h('span', { class: 'switch' }, input, h('span', { class: 'switch__track', 'aria-hidden': 'true' }, h('span', { class: 'switch__knob' }))),
  );
  return { row, input };
}

/**
 * チェックの行（iOS の「設定」アプリと同じ。1つだけ選び、選んだ行の右端にアクセント色の ✓）。
 * 設定のテーマ（端末に合わせる／ライト／ダーク）で使う（design 3.2 S-06・14.6.1）。T-15 で追加。
 *
 * なぜセグメントではなくこの形か：design 14.6.1 が iOS「設定」と同じチェックの行を指定しているため。
 * 中身は本物のラジオボタン（同じ name）。見た目からは隠すが、キーボードの矢印キー・読み上げ（「3個中1個目、選択中」）は
 * ブラウザ標準どおりに働く。行全体が <label> なので、行のどこを押しても選べる。
 * ✓ は「選択中」を色以外でも示す印（design 5.1）。読み上げはラジオボタンの状態で伝わるので、✓ 自体は飾り。
 * @param {{ name: string, options: {value:string, label:string}[], value?: (string|null), onChange?: (value:string) => void }} opts
 * @returns {{ rows: HTMLLabelElement[], getValue: () => (string|null), setValue: (v:string|null) => void }}
 *   rows は listGroup({ rows }) にそのまま渡す（グループの見出しが、まとまりの名前として読み上げられる）
 */
export function checkRows({ name, options, value = null, onChange }) {
  const groupName = `${name}-${uniqueId('chk')}`;
  const inputs = options.map((o) => h('input', {
    class: 'check-row__input visually-hidden', type: 'radio', name: groupName, value: o.value, checked: o.value === value,
    onChange: () => { if (onChange) onChange(o.value); },
  }));
  const rows = options.map((o, i) => h('label', { class: 'form-row check-row', dataset: { value: o.value } },
    inputs[i],
    h('span', { class: 'form-row__label' }, o.label),
    icon('check', { className: 'check-row__mark' }),
  ));
  return {
    rows,
    getValue: () => (inputs.find((x) => x.checked) || {}).value ?? null,
    setValue: (v) => { for (const x of inputs) x.checked = x.value === v; },
  };
}

/* ---------------------------------------------------------
   セグメント切替（design 9.3）
   中身は本物のラジオボタン（<input type="radio">）。見た目だけ変えるので、
   キーボードの矢印キー・読み上げ（「2個中1個目、選択中」など）がブラウザ標準どおりに働く。
   --------------------------------------------------------- */

/**
 * セグメント切替を作る。
 * @param {{ name: string, label: string, options: {value:string, label:string}[], value?: (string|null),
 *   variant?: 'default'|'side'|'account', onChange?: (value:string) => void }} opts
 *   label   … 読み上げ用のまとまりの名前（例「売買方向」）。画面には出さない
 *   variant … side＝買い/売り（選択中は青/赤の塗り）、account＝デモ/本番（琥珀/墨色）、default＝テーマなど
 *   value   … 最初に選ぶ値。null なら未選択（売買方向は毎回未選択から選ぶ：design 9.3）
 * @returns {{ el: HTMLDivElement, getValue: () => (string|null), setValue: (v:string|null) => void }}
 */
export function segment({ name, label, options, value = null, variant = 'default', onChange }) {
  const groupName = `${name}-${uniqueId('seg')}`; // 同じ画面に同じ name のセグメントが2つあっても混ざらないように
  const inputs = options.map((o) => h('input', {
    class: 'segment__input', type: 'radio', name: groupName, value: o.value, checked: o.value === value,
    onChange: () => { if (onChange) onChange(o.value); },
  }));
  const el = h('div', { class: `segment segment--${variant}`, role: 'radiogroup', 'aria-label': label },
    options.map((o, i) => h('label', { class: 'segment__option', dataset: { value: o.value } },
      inputs[i],
      h('span', { class: 'segment__text' }, o.label))),
  );
  return {
    el,
    getValue: () => (inputs.find((x) => x.checked) || {}).value ?? null,
    setValue: (v) => { for (const x of inputs) x.checked = x.value === v; },
  };
}

/** 買い/売りのセグメント（記号 ▲▼ を必ず付ける：色だけに頼らない。design 5.1） */
export function sideSegment({ value = null, onChange } = {}) {
  return segment({
    name: 'side', label: '売買方向', variant: 'side', value, onChange,
    options: [{ value: 'buy', label: '▲ 買い' }, { value: 'sell', label: '▼ 売り' }],
  });
}

/** デモ/本番のセグメント */
export function accountSegment({ value = null, onChange } = {}) {
  return segment({
    name: 'account', label: '口座', variant: 'account', value, onChange,
    options: [{ value: 'demo', label: 'デモ' }, { value: 'real', label: '本番' }],
  });
}

/* ---------------------------------------------------------
   チップ選択（design 9.4）
   1つ1つが aria-pressed 付きのボタン（押されている＝選択中、と読み上げられる）。
   --------------------------------------------------------- */

/**
 * チップの並びを作る。
 * @param {{ label: string, options: {value:string, label:string}[], selected?: string[], multiple?: boolean,
 *   required?: boolean, onChange?: (selected:string[]) => void, addLabel?: string, onAdd?: Function, className?: string }} opts
 *   multiple … true＝複数選べる（根拠・タグ）、false＝1つだけ（感情・時間足・決済理由・通貨ペア）
 *   required … 1つだけ選ぶとき、選択中をもう一度押しても解除しない（通貨ペアは必須：design 9.4）
 *   addLabel / onAdd … 末尾の「＋追加」チップ（入力画面ではタグだけ：design 9.4）
 *   className … 並べ方の種類。'chips--pair-grid'＝エントリー画面の通貨ペアの3列×2段の格子（design 9.4 の注記・14.1.2。T-15 で追加）
 * @returns {{ el: HTMLDivElement, getSelected: () => string[], setSelected: (v:string[]) => void }}
 */
export function chips({
  label, options, selected = [], multiple = false, required = false, onChange, addLabel = '', onAdd, className = '',
}) {
  let current = [...selected];
  const buttons = new Map();

  const render = () => {
    for (const [value, btn] of buttons) {
      const on = current.includes(value);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      // 選択中は先頭に ✓（色以外の区別：design 9.4）。読み上げは aria-pressed で伝わるので ✓ は飾り
      const mark = btn.querySelector('.chip__check');
      if (on && !mark) btn.prepend(icon('check', { size: 'xs', className: 'chip__check' }));
      if (!on && mark) mark.remove();
    }
  };

  const toggle = (value) => {
    const on = current.includes(value);
    if (multiple) {
      current = on ? current.filter((v) => v !== value) : [...current, value];
    } else if (on) {
      if (required) return; // 必須の項目は未選択に戻せない
      current = [];
    } else {
      current = [value];
    }
    render();
    if (onChange) onChange([...current]);
  };

  const el = h('div', { class: `chips${className ? ` ${className}` : ''}`, role: 'group', 'aria-label': label },
    options.map((o) => {
      const btn = h('button', { type: 'button', class: 'chip', onClick: () => toggle(o.value) }, h('span', {}, o.label));
      buttons.set(o.value, btn);
      return btn;
    }),
    addLabel ? h('button', { type: 'button', class: 'chip chip--add', onClick: onAdd }, icon('plus', { size: 'xs' }), h('span', {}, addLabel)) : null,
  );
  render();
  return {
    el,
    getSelected: () => [...current],
    setSelected: (v) => { current = [...v]; render(); },
  };
}

/* ---------------------------------------------------------
   エラー①・注意②の出し方（design 9.15・14.1.8）
   ① エラー：該当の行のラベルと値を赤に（セグメント・チップは外周に1pxの赤い枠）、グループの直下に ⚠＋文（赤）
   ② 注意  ：グループの直下に ⚠＋文（琥珀）。行の色は変えない。保存はできる
   どちらも「欄から離れたとき」と「保存を押したとき」に出す（入力中は責めない）。呼ぶタイミングは各画面が決める。
   --------------------------------------------------------- */

/** エラーの印を付ける相手（行の中の入力欄、またはセグメント・チップの外枠） */
function markTarget(target, on, messageId) {
  const ctrl = target.matches('input, textarea, select') ? target : null;
  const row = ctrl ? ctrl.closest('.form-row') : null;
  const box = ctrl ? row : target; // セグメント・チップは自分自身に枠を付ける
  if (box) box.classList.toggle('is-error', on);
  // 読み上げ：入力欄なら aria-invalid、どの文が説明かを aria-describedby で結ぶ（design 8.5）
  const a11y = ctrl || target;
  if (on) {
    a11y.setAttribute('aria-invalid', 'true');
    addIdRef(a11y, 'aria-describedby', messageId);
  } else {
    a11y.removeAttribute('aria-invalid');
    removeIdRef(a11y, 'aria-describedby', messageId);
  }
}

/**
 * ⚠＋文の1行（赤＝エラー／琥珀＝注意）。グループの直下（setGroupMessages）のほか、ボトムシートの検索欄の下など
 * グループがない場所にも同じ見た目で出せるよう、1行を作る部分だけ切り出した（T-16 で追加）。
 * @param {'error'|'warning'} type
 * @param {string} text
 * @param {string} [id] aria-describedby で結ぶための id
 */
export function messageLine(type, text, id = uniqueId('msg')) {
  return h('p', { class: `field-message field-message--${type}`, id },
    icon('warning', { size: 'xs', className: 'field-message__icon' }),
    // 読み上げでは ⚠ の代わりに「エラー」「注意」と読ませる（アイコンは飾り）
    h('span', { class: 'visually-hidden' }, type === 'error' ? 'エラー：' : '注意：'),
    h('span', {}, text));
}

/**
 * グループの直下のエラー文・注意文を入れ替える（同じグループに複数あれば上から順に1行ずつ）。
 * 前に出していた文と印はいったん全部消してから付け直すので、「直したら消える」も同じ関数で済む。
 * グループに説明文（listGroup の footer）があるときは、エラー文・注意文をその説明文より上（グループのすぐ下）に出す
 * （T-15 で変更：設定の1lotの通貨数のように2〜3行の説明文があると、下に足したエラー文が目に入りにくいため）。
 * @param {HTMLElement} group parts.js の listGroup() で作ったグループ
 * @param {{ type: 'error'|'warning', text: string, target?: HTMLElement, targets?: HTMLElement[] }[]} messages
 *   target：エラーの印を付ける入力欄（またはセグメント・チップの el）。注意（warning）では行の色を変えない
 *   targets：同じ文で複数の欄に印を付けるとき（設定の1lot デモ・本番が両方誤りのとき、同じ文を2行重ねないため。T-15 で追加）
 */
export function setGroupMessages(group, messages) {
  const footer = group.querySelector('.list-group__footer');
  // 前回の印を外す
  for (const old of footer.querySelectorAll('.field-message')) {
    for (const t of old._targets || []) markTarget(t, false, old.id);
    old.remove();
  }
  // 説明文の前に差し込む（説明文がなければ末尾＝先頭）
  const anchor = footer.firstChild;
  for (const m of messages) {
    const id = uniqueId('msg');
    const line = messageLine(m.type, m.text, id);
    line._targets = m.type === 'error' ? [...(m.targets || []), ...(m.target ? [m.target] : [])] : [];
    footer.insertBefore(line, anchor);
    for (const t of line._targets) markTarget(t, true, id);
  }
}
