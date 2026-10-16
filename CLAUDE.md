# FXトレード記録PWA

FXのデモトレード・本番トレードを、エントリー時（買い/売り）と決済時に記録し、過去の記録を振り返れるPWA。

## オーナーの前提
- 開発経験は「少しある」程度。専門用語には一言説明を添え、作業結果は分かりやすく報告する
- 回答・ドキュメントは日本語

## 決定済みの方針（ヒアリング結果 2026-10-15）
| 項目 | 決定内容 |
|---|---|
| 主な利用端末 | スマホ中心（片手・30秒以内で記録できること） |
| 記録項目 | 基本情報（日時・通貨ペア・売買方向・価格・ロット・デモ/本番）、損切り/利確ライン（SL/TP・リスクリワード）、根拠・メモ・感情・タグ、チャート画像 |
| データ保存 | 端末内（IndexedDB）を正とし、Googleスプレッドシートへ自動同期（Apps Script経由、無料） |
| 公開 | 無料のGitHub Pagesでホスティングし、スマホのホーム画面に追加。リポジトリ名は **fx-trade-note**（URLの一部になるため変更しない。変えるとホーム画面版のデータが引き継げない） |
| 取引対象 | FX通貨ペアのみ。高金利通貨（ZAR/JPY・MXN/JPY・TRY/JPY）は取引しないため、ペア別の1lot設定には対応しない |
| 技術 | 素のHTML/CSS/JavaScript、ビルド不要。グラフは Chart.js（CDN・バージョン固定） |
| 主な端末 | iPhone（iOS Safari・ホーム画面に追加して使う）。GitHubアカウントは保有済み |
| デザイン | **AIが作成したと分からないデザイン**（グラデーション・絵文字アイコン・すりガラス等を避け、iOS標準アプリに馴染む実用的な見た目）。詳細は .claude/agents/designer.md と docs/design.md |

## トレードの記録の流れ
1. エントリー時：新規記録（status = open）
2. 決済時：同じ記録に決済価格・日時を追加し、pips・損益を計算（status = closed）
3. 振り返り：一覧・検索・分析画面で確認

## AI社員（.claude/agents/）
| 名前 | 役割 |
|---|---|
| `pm` | 要件定義・タスク分解・進行管理。迷ったら最初に相談 |
| `designer` | 画面設計・デザインルール |
| `engineer` | PWA実装・データ保存・オフライン対応・公開 |
| `reviewer` | コードレビュー・機能テスト（データ消失・計算ミス防止） |
| `ux-tester` | ブラウザで実際に操作して使い勝手を検証 |
| `fx-expert` | pips・損益などFX計算式と用語の正しさを担保 |
| `data-analyst` | 振り返り・統計・グラフ機能の設計 |
| `sheets-integrator` | Googleスプレッドシート自動記録（Apps Script） |

### 標準の進め方
pm（仕様・タスク化） → fx-expert / data-analyst（ルール・指標の定義） → designer（画面設計） → engineer / sheets-integrator（実装） → reviewer + ux-tester（検証） → engineer（修正）

## ドキュメント配置
- `docs/requirements.md` 仕様書 / `docs/roadmap.md` ロードマップ（pm）
- `docs/design.md` 画面設計（designer）
- `docs/fx-rules.md` FX計算ルール（fx-expert）
- `docs/analytics.md` 分析機能設計（data-analyst）
- `docs/sheets-setup.md` スプレッドシート連携の手順（sheets-integrator）
- `docs/architecture.md` 技術設計：ファイル構成・IndexedDBスキーマ（engineer）

## 注意
- このアプリは記録・振り返り用ツール。売買の推奨や投資助言にあたる機能・文言は入れない
- Apps ScriptのURLや合言葉はコードに直書きせず、アプリの設定画面から入力する
