/* =========================================================
   js/screens/install-guide.js
   S-06 の下位画面「ホーム画面への追加」。型C。URL：#/settings/install（design.md 14.6.6）

   【T-10】ナビゲーションバー（‹ 設定）の入れ物だけ。
   【T-29】中身を作った（design 14.6.6、architecture 12.5・17章 #1・#2）：
     ・今の状態（ホーム画面のアプリで開いている ✓／Safariで開いている ⚠）と、追加すると消えにくくなる説明
     ・iPhone（Safari）と Android（Chrome）の追加の手順（手順の画像は使わず、ボタンの形は線画アイコンで示す。
       iOS の版で見た目が変わり、古い画像が誤解を招くため）
     ・記録の保存について（Safari とホーム画面版で記録が別、アイコンを消すと記録も消える、Safari で7日使わないと消えることがある）。
       毎回目に入る説明なので警告色にはせず、黒の本文で落ち着いて読めるようにする（design 14.6.6）
     ・「CSVを書き出す」（設定の「CSVを書き出す」と同じ動き：screens/settings-data.js の exportCsv）
     ナビゲーションバーの画面名は「ホーム画面への追加」（幅の都合で短くする。設定画面の行の名前は「ホーム画面への追加方法 ›」のまま）。
   状態の判定は js/data-protection.js の installState（テストあり）。
   文字はすべて ui/dom.js の h() を通す（innerHTML は使わない：architecture 14.1）。
   ========================================================= */
import { h } from '../ui/dom.js';
import { navbar, backButton } from '../ui/bars.js';
import { listGroup } from '../ui/parts.js';
import { icon } from '../ui/icons.js';
import { installState } from '../data-protection.js';
import { getAllTrades } from '../trades.js';
import { countTrades } from '../csv.js';
import { exportCsv } from './settings-data.js';

/** 今の状態の行（✓ はアクセント色、⚠ は琥珀：design 14.6.6） */
function stateGroup() {
  const state = installState();
  return listGroup({
    rows: [
      h('div', { class: `list-row install-state install-state--${state.tone}` },
        icon(state.tone === 'ok' ? 'check' : 'warning', { className: 'install-state__icon' }),
        h('span', { class: 'install-state__text' }, state.text)),
    ],
    footer: h('p', {}, 'ホーム画面に追加すると、全画面で開け、記録が消えにくくなります。'),
  });
}

/**
 * 手順の1行。番号（等幅・灰）＋本文（＋2行目 15px・灰）。
 * @param {number} n 番号
 * @param {Array<string|Node>} text 本文（線画アイコンを文中に入れられるよう、文字とアイコンの並びで渡す）
 * @param {string} [sub] 2行目
 */
function stepRow(n, text, sub = '') {
  return h('div', { class: 'list-row install-step' },
    h('span', { class: 'install-step__num num', 'aria-hidden': 'true' }, String(n)),
    h('div', { class: 'install-step__body' },
      // 読み上げでは番号を「1.」として読ませる（見た目の番号は aria-hidden にして二重に読ませない）
      h('p', { class: 'install-step__text' }, h('span', { class: 'visually-hidden' }, `${n}. `), text),
      sub ? h('p', { class: 'install-step__sub' }, sub) : null));
}

/** 文中に置く線画アイコン（共有ボタン ⍐・縦の三点 ⋮）。読み上げ用の名前を付ける */
function inlineIcon(name, label) {
  return icon(name, { size: 'sm', className: 'install-step__icon', label });
}

function iphoneGroup() {
  return listGroup({
    header: 'iPhone（Safari）',
    rows: [
      stepRow(1, ['画面下の共有ボタン ', inlineIcon('share', '共有'), ' をタップ']),
      stepRow(2, ['「ホーム画面に追加」をタップ。'], '見つからないときは下へスクロール'),
      stepRow(3, ['右上の「追加」をタップ']),
    ],
  });
}

function androidGroup() {
  return listGroup({
    header: 'Android（Chrome）',
    rows: [
      stepRow(1, ['右上の ', inlineIcon('moreVertical', 'メニュー'), ' をタップ']),
      stepRow(2, ['「ホーム画面に追加」または「アプリをインストール」をタップ']),
      stepRow(3, ['「インストール」をタップ']),
    ],
  });
}

/** 記録の保存について（design 14.6.6 の3項目。本文17px・左揃え、項目ごとに1行） */
function storageNotesGroup() {
  const notes = [
    'Safari とホーム画面のアプリでは、記録が別々に保存されます。Safariで入れた記録は、ホーム画面のアプリには出ません。',
    'ホーム画面のアイコンを削除すると、記録も消えます。削除や機種変更の前に、CSVを書き出してください。',
    'Safariで開いたまま7日間使わないと、記録が消えることがあります。',
  ];
  return listGroup({
    header: '記録の保存について',
    rows: notes.map((text) => h('p', { class: 'list-row install-note' }, text)),
  });
}

/**
 * 「CSVを書き出す」のグループ。押したときの動きは設定画面と同じ（exportCsv）。削除済みの記録は含めない
 * （「含める」のスイッチは設定画面にだけある。ここは「とりあえず今の記録を保存しておく」ための入口なので、既定の「含めない」で書き出す）。
 * 記録が0件のときは押せなくして、設定画面と同じ文で理由を示す（design 14.6.5）。
 * @returns {{ group: HTMLElement, dispose: () => void }}
 */
function exportGroup() {
  let alive = true;
  let busy = false;
  let live = null; // 書き出せる記録の数（読み込めるまで null）
  const note = h('p', {}, '');
  const exportBtn = h('button', { type: 'button', class: 'list-row export-row', onClick: () => start() },
    h('span', { class: 'list-row__label' }, 'CSVを書き出す'));

  const render = () => {
    if (!alive) return;
    note.textContent = live === 0 ? '記録がないため書き出せません。' : '';
    if (!busy) exportBtn.disabled = live === 0;
  };

  async function start() {
    if (busy) return;
    busy = true;
    try {
      await exportCsv({ includeDeleted: false, button: exportBtn, onCounts: (c) => { live = c.live; render(); } });
    } finally {
      busy = false;
      render();
    }
  }

  getAllTrades().then((trades) => {
    live = countTrades(trades).live;
    render();
  }).catch((e) => {
    // 読めなくても押せるままにする（押したときに改めて読み、失敗ならアラート：settings-data.js）
    console.error('記録の件数を読み込めませんでした', e);
  });

  return {
    group: listGroup({ rows: [exportBtn], footer: note }),
    dispose() {
      alive = false;
    },
  };
}

let exporter = null;

export default {
  layout: 'detail',
  tab: null,
  title: 'ホーム画面への追加',

  mount(root, { nav }) {
    exporter = exportGroup();
    root.append(
      navbar({
        left: backButton('設定', () => nav.back('#/settings')),
        title: 'ホーム画面への追加',
      }),
      h('div', { class: 'screen__body' },
        stateGroup(),
        iphoneGroup(),
        androidGroup(),
        storageNotesGroup(),
        exporter.group,
      ),
    );
  },

  unmount() {
    if (exporter) exporter.dispose();
    exporter = null;
  },

  hasUnsavedChanges() {
    return false;
  },
};
