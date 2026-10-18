/* =========================================================
   js/ui/image-field.js
   入力画面（S-02 エントリー・S-03 決済・S-05 編集）の「画像（最大4枚）」グループ（design.md 14.1.9・14.2.10・14.5.1）、
   と、詳細画面（S-04）の「画像（N枚）」のサムネイルの並び（design 14.4.1）。

   【入力画面のグループ（imageField）】
   ・サムネイル（4列・正方形・角丸）を並べ、下に「画像を追加（残り2枚）」の行。4枚になったら行を無効にして「画像は4枚までです」。
   ・選んだ画像は 1 枚ずつ順に、縮小・JPEG 圧縮して images に保存し（architecture 11.1・11.5）、その ID を覚える（下書きの addedImageIds になる）。
     処理中はサムネイルの枠に回転アイコン。残り枚数より多く選んだら先頭から残り枚数分だけ追加し、「4枚を超えた分は追加しませんでした」。
     読み込めない画像は「画像を読み込めませんでした。別の画像を選んでください。」（赤）。他の入力は残る。
   ・サムネイルの × （見た目20px・押せる範囲44px）：
       この入力で追加した画像 … 確認なしで即削除（まだ保存していない画像なので：requirements F-05）。images からも消す
       保存済みの画像（編集のみ）… 一覧から外すだけ。物理削除は「変更を保存」のとき（キャンセルなら元に戻る：architecture 11.4）
       保存済みの画像（決済）… × を出さない（削除は編集画面：design 14.2.10）
   ・サムネイルをタップで拡大表示（ui/image-viewer.js。入力画面からは「削除」を出さない）。
   ・保存済みの画像を読み込めない（壊れている・見つからない）ときは、その1枚だけ「読み込めません」にする。記録全体は壊さない。
   ・画面を離れるとき・保存したとき・破棄したときは dispose() を呼ぶ：表示用 URL をすべて解放し、処理中の画像は保存せずに捨てる
     （画面が閉じたあとに画像だけが保存されて、孤立画像として残らないように）。
   ・【T-33：T-30 の R-04】保存の途中は setDisabled(true) で「画像を追加」と × を押せなくする（画面の setSaving から呼ぶ）。
     保存を押したあとに足した画像が、記録に入らないまま黙って消えるのを防ぐため。あわせて whenIdle() は、待っている間に
     足された画像も含めて「処理中の枠が0になるまで」待つ。

   画面との約束：画面は画像の保存・削除の「結果」を getAddedIds() / getRemovedIds() で受け取って記録・下書きに反映する。
   画像と記録の保存の順序（画像が先）は images.js の冒頭を参照。

   文字はすべて ui/dom.js の h() を通す（innerHTML は使わない：architecture 14.1）。
   ========================================================= */
import { h } from './dom.js';
import { icon } from './icons.js';
import { listGroup, spinner } from './parts.js';
import { setGroupMessages } from './fields.js';
import { showAlert } from './dialog.js';
import { openImageViewer, closeImageViewer } from './image-viewer.js';
import {
  imageService, createUrlPool, planAddition, remainingSlots, addRowText, imageAlt, IMAGE_TEXT,
} from '../images.js';
import { MAX_IMAGES_PER_TRADE } from '../config.js';
import { isAppError } from '../util.js';

/** サムネイル 1 枚分の要素（入力画面・詳細画面で共通） */
function thumbBase(...children) {
  return h('div', { class: 'img-thumb' }, ...children);
}

/** 読み込み中・処理中の枠（--color-fill の中に回転アイコン：design 14.7.7） */
export function loadingThumb(label = '読み込み中') {
  return thumbBase(h('div', { class: 'img-thumb__state' }, spinner(label)));
}

/** 読み込めない画像の枠（その1枚だけ。記録全体の表示は壊さない：architecture 17章 #11） */
export function brokenThumb() {
  return thumbBase(h('div', { class: 'img-thumb__state img-thumb__broken', role: 'img', 'aria-label': '画像を読み込めません' }, h('span', {}, IMAGE_TEXT.broken)));
}

/**
 * 読み出せた画像のサムネイル（押すと onOpen）。<img> の読み込みに失敗したら onBroken（その枠を「読み込めません」にするのは呼び出し側）。
 * @param {{url: string, kind: string, index: number, total: number, onOpen: Function, onBroken?: Function}} opts
 */
export function imageThumb({ url, kind, index, total, onOpen, onBroken }) {
  const img = h('img', { class: 'img-thumb__img', src: url, alt: imageAlt(kind, index, total), decoding: 'async' });
  if (onBroken) img.addEventListener('error', onBroken);
  return thumbBase(h('button', { type: 'button', class: 'img-thumb__open', onClick: onOpen }, img));
}

/**
 * 入力画面の画像グループを作る。
 * @param {object} opts
 * @param {string} opts.tradeId 画像の持ち主の記録 ID（新規は入力画面を開いた時点で採番した ID：architecture 11.5）
 * @param {'entry'|'exit'} opts.kind 今回追加する画像の添付タイミング
 * @param {string} [opts.header] グループの見出し（決済は「画像（最大4枚・エントリーと合わせて）」）
 * @param {string[]} [opts.existingIds] すでに記録に付いている画像の ID（imageIds の順）
 * @param {boolean} [opts.removableExisting] 保存済みの画像にも × を付けるか（編集だけ true）
 * @param {string[]} [opts.addedIds] 下書きから復元する、この入力で追加済みの画像の ID
 * @param {string[]} [opts.removedIds] 下書きから復元する、編集で外した画像の ID（existingIds の一部）
 * @param {() => void} [opts.onChange] 追加・削除・外したとき（下書きの保存を予約する）
 * @param {() => void} [opts.onBeforePick] 写真の選択画面を開く直前（下書きの即時保存：iPhone はカメラ起動でページが再読み込みされることがある。architecture 9.2）
 * @param {() => void} [opts.onAdded] 画像を 1 枚 images に保存した直後（下書きに ID をすぐ書く）
 * @param {object} [opts.service] 画像の業務処理（既定は本物の imageService。テストで差し替える）
 */
export function imageField({
  tradeId, kind, header = `画像（最大${MAX_IMAGES_PER_TRADE}枚）`, existingIds = [], removableExisting = false,
  addedIds = [], removedIds = [], onChange = () => {}, onBeforePick = () => {}, onAdded = () => {}, service = imageService,
}) {
  const pool = createUrlPool();
  let disposed = false;
  let disabled = false; // 保存の途中（setDisabled）。追加・外すを受け付けない
  let seq = 0;
  let queue = Promise.resolve();
  const text = { error: '', warn: '', overflow: '' };

  /**
   * 表示中の画像。origin：'existing'（保存済み）／'added'（この入力で追加）／'processing'（縮小中）
   * status：'loading'（読み込み中）／'ready'（表示できる）／'broken'（読み込めない）／'processing'
   */
  const removed = removableExisting ? existingIds.filter((id) => removedIds.includes(id)) : [];
  let items = [
    ...existingIds.filter((id) => !removed.includes(id)).map((id) => ({ key: ++seq, id, origin: 'existing', status: 'loading', kind: 'entry', blob: null, url: '', busy: false })),
    ...addedIds.filter((id) => !existingIds.includes(id)).map((id) => ({ key: ++seq, id, origin: 'added', status: 'loading', kind, blob: null, url: '', busy: false })),
  ];

  /* ----- 部品 ----- */
  const input = h('input', {
    type: 'file', accept: 'image/*', multiple: true, class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true',
    onChange: () => onPicked(),
  });
  const addLabel = h('span', { class: 'img-add__label' });
  const addBtn = h('button', {
    type: 'button', class: 'list-row img-add',
    onClick: () => {
      if (disabled) return;
      onBeforePick();
      input.click();
    },
  }, icon('photo', { size: 'sm' }), addLabel);
  const overflowNote = h('p', { class: 'img-note' });
  const removedNote = h('p', { class: 'img-note' }, IMAGE_TEXT.removedNote);
  const group = listGroup({ header, className: 'img-field', rows: [], footer: [overflowNote, removedNote] });
  group.append(input); // 入力欄はグループの行の外に置く（行の間のヘアラインが入力欄の分だけ引かれないように）
  const body = group.querySelector('.list-group__body');

  /* ----- 表示 ----- */
  function canRemove(item) {
    if (item.origin === 'processing' || item.busy) return false;
    return item.origin === 'added' || (item.origin === 'existing' && removableExisting);
  }

  function tile(item, readyItems) {
    let node;
    if (item.status === 'ready') {
      node = imageThumb({
        url: item.url, kind: item.kind, index: readyItems.indexOf(item), total: readyItems.length,
        onOpen: () => openViewer(item, readyItems),
        onBroken: () => { markBroken(item); },
      });
    } else if (item.status === 'broken') {
      node = brokenThumb();
    } else {
      node = loadingThumb(item.status === 'processing' ? '画像を処理中' : '読み込み中');
    }
    if (canRemove(item)) {
      // 保存の途中は押せないだけにする（× を消すとサムネイルの見た目が変わり、何かが起きたように見えるため）
      node.append(h('button', { type: 'button', class: 'img-thumb__remove', 'aria-label': 'この画像を外す', disabled, onClick: () => remove(item) },
        h('span', { class: 'img-thumb__remove-mark', 'aria-hidden': 'true' }, icon('close', { size: 'xs' }))));
    }
    return node;
  }

  function render() {
    if (disposed) return;
    const readyItems = items.filter((i) => i.status === 'ready');
    const rows = [];
    if (items.length > 0) rows.push(h('div', { class: 'img-grid' }, items.map((i) => tile(i, readyItems))));
    rows.push(addBtn);
    body.replaceChildren(...rows);
    const left = remainingSlots(items.length);
    addLabel.textContent = addRowText(left);
    addBtn.disabled = disabled || left === 0;
    overflowNote.textContent = text.overflow;
    overflowNote.hidden = text.overflow === '';
    removedNote.hidden = !(removableExisting && removed.length > 0);
    // ⚠ のエラー文（赤）・注意文（琥珀）は他の入力欄と同じ出し方（fields.js）。説明文（上の2つの灰色の文）より上に入る
    setGroupMessages(group, [
      ...(text.error ? [{ type: 'error', text: text.error }] : []),
      ...(text.warn ? [{ type: 'warning', text: text.warn }] : []),
    ]);
  }

  function openViewer(item, readyItems) {
    openImageViewer({
      items: readyItems.map((i) => ({ id: i.id, kind: i.kind, blob: i.blob })),
      index: readyItems.indexOf(item),
    });
  }

  function markBroken(item) {
    if (disposed || item.status === 'broken') return;
    item.status = 'broken';
    if (item.url) { pool.revoke(item.url); item.url = ''; }
    render();
  }

  function drop(item) {
    items = items.filter((x) => x !== item);
    if (item.url) { pool.revoke(item.url); item.url = ''; }
  }

  /* ----- 保存済み・復元した画像の読み込み ----- */
  async function load(item) {
    const r = await service.loadImage(item.id);
    if (disposed) return;
    if (r.status === 'ok') {
      item.kind = r.image.kind;
      item.blob = r.image.blob;
      item.url = pool.urlOf(r.image.blob);
      item.status = 'ready';
    } else if (r.status === 'missing' && item.origin === 'added') {
      // 下書きが覚えていた画像が、もう無い（別の画面・掃除で消えた）。黙って外し、下書きを書き直す
      drop(item);
      render();
      onChange();
      return;
    } else {
      item.status = 'broken';
    }
    render();
  }

  /* ----- 追加 ----- */
  function onPicked() {
    const files = [...(input.files || [])];
    input.value = ''; // 同じファイルをもう一度選べるように
    if (files.length > 0) addFiles(files);
  }

  function addFiles(files) {
    text.error = '';
    text.warn = '';
    text.overflow = '';
    const plan = planAddition(items.length, files.length);
    if (plan.rejected > 0) text.overflow = IMAGE_TEXT.overLimit;
    const accepted = files.slice(0, plan.accept);
    // 枠を先に確保する（処理中も枚数に数え、続けて選んでも上限を超えないように）
    const holders = accepted.map(() => ({ key: ++seq, id: '', origin: 'processing', status: 'processing', kind, blob: null, url: '', busy: false }));
    items.push(...holders);
    render();
    if (accepted.length > 0) enqueue(() => processAll(accepted, holders));
  }

  /** 1枚ずつ順に処理する（同時に処理するとメモリ不足でページが落ちることがある：architecture 11.1 ②） */
  function enqueue(task) {
    queue = queue.then(task).catch((e) => console.error('画像の追加でエラーが起きました', e));
    return queue;
  }

  async function processAll(files, holders) {
    if (await service.checkLowStorage()) {
      text.warn = IMAGE_TEXT.lowStorage;
      render();
    }
    for (let i = 0; i < files.length; i += 1) {
      if (disposed) return;
      const outcome = await addOne(files[i], holders[i]);
      if (outcome === 'stop') {
        // 容量不足など。残りの分も同じ理由で失敗するので、枠を外して終える
        for (const rest of holders.slice(i + 1)) drop(rest);
        render();
        return;
      }
    }
  }

  /** @returns {Promise<'ok'|'failed'|'stop'>} */
  async function addOne(file, holder) {
    try {
      const prepared = await service.prepareImage(file);
      if (disposed) return 'failed';
      const rec = await service.saveImage({ tradeId, kind, blob: prepared.blob, width: prepared.width, height: prepared.height });
      if (disposed) {
        // 保存している間に画面が閉じられた：画像だけが残らないよう、いま保存したものを消す
        await service.deleteImages([rec.id]).catch((e) => console.error('画像を消せませんでした', e));
        return 'failed';
      }
      holder.id = rec.id;
      holder.origin = 'added';
      holder.status = 'ready';
      holder.kind = rec.kind;
      holder.blob = rec.blob;
      holder.url = pool.urlOf(rec.blob);
      render();
      onAdded(); // 画像の ID を下書きにすぐ書く（architecture 11.5）
      onChange();
      return 'ok';
    } catch (e) {
      if (disposed) return 'failed';
      drop(holder);
      if (isAppError(e, 'IMAGE_DECODE')) {
        text.error = IMAGE_TEXT.decodeError;
        render();
        return 'failed';
      }
      console.error('画像を追加できませんでした', e);
      render();
      // 容量不足など保存の失敗は、自動で消えないアラートで知らせる（architecture 15.1）。入力内容は画面に残っている
      const quota = isAppError(e, 'QUOTA');
      await showAlert({
        title: '画像を保存できませんでした',
        message: quota || isAppError(e, 'DB_WRITE')
          ? '端末の空き容量が不足している可能性があります。入力内容はこの画面に残っています。'
          : '保存中に問題が起きました。入力内容はこの画面に残っています。',
      });
      return 'stop';
    }
  }

  /* ----- 外す ----- */
  async function remove(item) {
    if (item.busy || disposed || disabled) return;
    if (item.origin === 'existing') {
      // 保存済みの画像：一覧から外すだけ。物理削除は「変更を保存」のとき（キャンセルなら元に戻る）
      removed.push(item.id);
      drop(item);
      text.overflow = '';
      render();
      onChange();
      return;
    }
    // この入力で追加した画像：まだ保存していないので確認なしで消す（requirements F-05）。images からも消す
    item.busy = true;
    render();
    try {
      await service.deleteImages([item.id]);
    } catch (e) {
      console.error('画像を削除できませんでした', e);
      item.busy = false;
      render();
      await showAlert({ title: '画像を削除できませんでした', message: '画像はそのまま残っています。' });
      return;
    }
    if (disposed) return;
    drop(item);
    text.overflow = '';
    render();
    onChange();
  }

  /* ----- 公開 ----- */
  const addedIdsNow = () => items.filter((i) => i.origin === 'added' && i.id).map((i) => i.id);

  // 最初の読み込み（保存済み・復元した画像）
  render();
  const ready = Promise.all(items.map((i) => load(i)));

  return {
    el: group,
    /** この入力で追加して images に保存済みの画像の ID（追加した順） */
    getAddedIds: addedIdsNow,
    /** 編集で外した保存済みの画像の ID（「変更を保存」で物理削除する） */
    getRemovedIds: () => [...removed],
    /** 今の枚数（処理中を含む） */
    count: () => items.length,
    /** 追加した枚数（「詳細（任意）」を閉じたときの 2 行目に使う） */
    addedCount: () => addedIdsNow().length,
    /** 追加・外したものがあるか（「変更あり」の判定に加える） */
    isChanged: () => addedIdsNow().length > 0 || removed.length > 0,
    /**
     * 縮小・保存の処理が終わるのを待つ（処理中に保存を押したときは、終わってから保存する：design 14.1.9）。
     * 待っている間に足された画像（呼んだ時点では queue に入っていない分）も待つよう、処理中の枠が0になるまで繰り返す（R-04）。
     * 処理中の枠が残っていても、待つ相手（queue）が前と同じなら止める（処理が途中で失敗して枠が残ったときに、待ち続けないため）。
     */
    async whenIdle() {
      let waited = null;
      while (!disposed && items.some((i) => i.origin === 'processing') && waited !== queue) {
        waited = queue;
        await waited;
      }
    },
    /**
     * 保存の途中は「画像を追加」と × を押せなくする（R-04）。保存に失敗して入力に戻るときは false で戻す。
     * @param {boolean} on
     */
    setDisabled(on) {
      disabled = Boolean(on);
      render();
    },
    /** 最初の読み込みが終わるのを待つ（テスト用） */
    ready,
    /**
     * 追加した画像のうち images から消えているものを外す（保存で IMAGE_MISSING になったあとに呼ぶ）。外した数を返す。
     * 記録が指す画像が無い状態を作らず、画面を最新の状態に合わせるため。
     */
    async pruneMissing() {
      let count = 0;
      for (const item of [...items]) {
        if (item.origin !== 'added') continue;
        let found;
        try {
          found = await service.getImage(item.id);
        } catch (e) {
          continue;
        }
        if (found === null) {
          drop(item);
          count += 1;
        }
      }
      if (count > 0) {
        render();
        onChange();
      }
      return count;
    },
    /** 画面を離れる・保存した・破棄した：表示用 URL をすべて解放し、処理中の画像は保存せずに捨てる */
    dispose() {
      disposed = true;
      closeImageViewer();
      pool.revokeAll();
    },
  };
}
