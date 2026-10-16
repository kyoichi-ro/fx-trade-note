/* =========================================================
   js/ui/tag-picker.js
   タグの選択グループ（チップ＋「＋追加」）。エントリー画面（S-02）と決済画面（S-03）で共通（design.md 9.4・14.1.5・14.2.6 ⑥、T-18）。

   【なぜ共通の部品にしたか】
   エントリーと決済は同じ「1つのタグ配列」を編集するため、見た目も追加の動きもそろえたい。2か所に同じ処理を書くと、
   片方だけ直して食い違う事故になる（名前のチェック・設定への保存・保存失敗のアラートなど）。

   【「＋追加」の動き（design 14.1.5）】
   ・「＋追加」のチップを押すと、グループの下に名前の入力欄の行が開き、キーボードが出る。
   ・「完了」（Enter）か欄から離れると追加する。空のまま離れたら行を閉じるだけ（エラーにしない）。
   ・名前のチェックは choice-list.js（空白だけ・20文字以内・同じ名前は不可）。T-16 の設定画面と同じ規則・同じ文言。
   ・追加したタグは設定の選択肢（choices.tags）にも加える（次回からチップで選べる）。この画面でもそのまま選択済みにする
     （追加するのは、今の記録に付けたいからなので）。
   ・設定を保存できなかったとき（容量不足など）は、設定画面と同じアラート「設定を保存できませんでした」。
     保存されていない名前を画面だけに出すと、次に開いたときに消えて食い違うため、チップは増やさない。
   ・根拠・感情はこの画面では追加できない（分析の切り口を安定させるため：design 14.2.12 ⑥）。設定画面でだけ追加する。

   依存：ui（dom・fields・parts・icons・dialog）、choice-list、settings-store
   ========================================================= */
import { h } from './dom.js';
import { icon } from './icons.js';
import { chips, setGroupMessages } from './fields.js';
import { listGroup } from './parts.js';
import { alertSettingsWriteFailed } from './dialog.js';
import { getSetting, setSetting } from '../settings-store.js';
import { withSelected, planTagAdd, CHOICE_NAME_ERROR_TEXTS } from '../choice-list.js';
import { CHOICE_NAME_MAX_LENGTH } from '../config.js';
import { isAppError } from '../util.js';

/**
 * タグのグループを作る。
 * @param {{ selected?: string[], onChange?: (selected:string[]) => void, header?: string }} [opts]
 *   selected … 最初に選んでおくタグ（設定から消された名前でもチップに残す：選択済みのまま見えなくならないように）
 *   onChange … 選択が変わったとき（チップを押した・追加した）に、選択中のタグの配列を渡す
 * @returns {{ el: HTMLElement, getSelected: () => string[], setSelected: (v:string[]) => void }}
 *   el は listGroup（画面の中にそのまま置く）
 */
export function tagPicker({ selected = [], onChange = () => {}, header = 'タグ（複数選択）' } = {}) {
  let adding = false;   // 名前の入力欄を開いているか
  let alerting = false; // 保存失敗のアラートを出している間（欄から離れる動きが重ねて保存し直さないように）
  let inputRow = null;

  const options = withSelected(getSetting('choices').tags, selected);
  const picker = chips({
    label: 'タグ', options: options.map((v) => ({ value: v, label: v })), selected, multiple: true,
    addLabel: '追加', onAdd: () => startAdd(), onChange: (sel) => onChange(sel),
  });
  const group = listGroup({ header, rows: [h('div', { class: 'field-row' }, picker.el)] });
  const body = group.querySelector('.list-group__body');

  /** 名前の入力欄の行。「完了」（Enter）で追加、欄から離れたときも追加（空なら行を閉じるだけ） */
  function makeInputRow() {
    const input = h('input', {
      class: 'form-row__input choice-add__input', type: 'text', 'aria-label': 'タグの名前',
      placeholder: `名前（${CHOICE_NAME_MAX_LENGTH}文字以内）`, enterkeyhint: 'done',
      autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
      // 文字を直し始めたら、前のエラーは消す（直したら消える：design 9.15）
      onInput: () => setGroupMessages(group, []),
      onKeydown: (e) => {
        // 日本語入力の変換を確定する Enter では追加しない（変換中は isComposing）
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); } // 「完了」＝欄から離れる（blur で追加する）
        if (e.key === 'Escape') { input.value = ''; input.blur(); }
      },
      onBlur: () => commit(input),
    });
    const row = h('label', { class: 'form-row choice-add-row' }, icon('plus', { size: 'sm', className: 'choice-add-row__icon' }), input);
    return { row, input };
  }

  function startAdd() {
    if (adding) {
      inputRow.input.focus();
      return;
    }
    adding = true;
    inputRow = makeInputRow();
    body.append(inputRow.row);
    inputRow.input.focus(); // 「＋追加」を押した処理の中で呼ぶので、iPhone でもキーボードが出る
    inputRow.row.scrollIntoView({ block: 'nearest' });
  }

  function closeInput() {
    adding = false;
    setGroupMessages(group, []);
    if (inputRow) inputRow.row.remove();
    inputRow = null;
  }

  /** 入力欄から離れた：空なら行を閉じる／名前をチェックして設定に保存し、チップに加えて選ぶ */
  function commit(input) {
    if (!adding || alerting) return;
    if (input.value.trim() === '') {
      closeInput();
      return;
    }
    const visible = [...picker.el.querySelectorAll('.chip:not(.chip--add)')].map((b) => b.textContent);
    const plan = planTagAdd(getSetting('choices').tags, visible, input.value);
    if (!plan.ok) {
      setGroupMessages(group, [{ type: 'error', text: CHOICE_NAME_ERROR_TEXTS[plan.error], target: input }]);
      return;
    }
    try {
      // 保存する直前に最新の choices を読み直して、タグだけ差し替える（根拠・感情を古い値で上書きしないため）
      setSetting('choices', { ...getSetting('choices'), tags: plan.list });
    } catch (e) {
      if (!isAppError(e, 'SETTINGS_WRITE')) throw e;
      console.error('タグを設定に保存できませんでした', e);
      alerting = true;
      alertSettingsWriteFailed().finally(() => { alerting = false; });
      return;
    }
    if (plan.isNewChip) picker.addOption({ value: plan.name, label: plan.name });
    const next = picker.getSelected().filter((v) => v !== plan.name);
    picker.setSelected([...next, plan.name]);
    closeInput();
    onChange(picker.getSelected());
  }

  return { el: group, getSelected: picker.getSelected, setSelected: picker.setSelected };
}
