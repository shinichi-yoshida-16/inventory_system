# 整備部品在庫管理システム

中古自動車販売の整備工場向けに、スマホ・PC・Googleサービスを連携して部品/消耗品の在庫管理をリアルタイム化するシステム。要件定義からアーキテクチャ設計・実装・技術検証までを一貫してAI活用開発で行った個人開発プロジェクト。

## 課題と解決
- 紙ベースの在庫管理により、リアルタイムの在庫把握・入出庫管理ができておらず、欠品にも気付けない
- QR/JANコード/GS1 DataMatrixをスマホで読み取るだけで入出庫が記録され、閾値を下回ると担当者へメール通知される仕組みで解消

## 主な機能
- メールアドレスによる簡易ログイン（許可リスト照合）
- ダッシュボード（在庫状況の一覧表示）
- 在庫一覧・閾値設定・QRコード発行（PC操作）
- QR / JANコード（EAN-13） / GS1 DataMatrix読み取りによる入出庫登録（スマホ操作、ZXing-js使用）
- 閾値割れ時の自動メールアラート（GmailApp）

## 技術スタック
- Google Apps Script（V8ランタイム）/ HTML Service
- Google スプレッドシート（DBとして使用）
- ZXing-js（マルチフォーマットコード読取）
- GitHub Pages + GitHub Actions（QRスキャン画面の外部ホスティング）

## アーキテクチャ
- [全体構成・API設計](docs/architecture/overview.md)
- [シーケンス図](docs/architecture/sequence.md)
- [データベース設計](docs/architecture/database.md)
- [画面遷移設計](docs/architecture/transition.md)
- [要件定義書](docs/requirements/requestment.md) / [技術検証結果](docs/requirements/technical_verification.md)
- [ユーザーマニュアル](docs/manuals/user_manual.md)

構成の詳細は [docs/architecture/overview.md](docs/architecture/overview.md) の全体構成図（GAS Web App / 外部ホスティング / スプレッドシートの3ドメイン構成）を参照。

## セットアップ（自分の環境で動かす場合）
1. GAS本体（`src/core/`, `src/frontend/`, `src/appsscript.json`）を [clasp](https://github.com/google/clasp) 等でGoogle Apps Scriptプロジェクトへpushする
2. 在庫マスタ等のシート構成に沿ったGoogleスプレッドシートを用意し、スクリプトプロパティ `SPREADSHEET_ID` にそのIDを設定する（詳細: [database.md](docs/architecture/database.md)）
3. GASをWebアプリとしてデプロイし、発行された `/exec` URLを控える
4. `src/external/gf03-scan/index.html` 内の `GAS_WEB_APP_URL` を手順3のURLに書き換える
5. リポジトリの `src/external/gf03-scan/` を GitHub Pages 等で公開する（`.github/workflows/deploy-gf03-scan.yml` を利用可能）
6. GASのスクリプトプロパティ `GF03_URL` に手順5の公開URLを設定する

デプロイ手順の詳細は [docs/architecture/overview.md 7章](docs/architecture/overview.md) を参照。

## 既知の制約
- 認証はメールアドレス入力＋許可リスト照合のみで、パスワードやOAuthによる本人確認は行っていない（要件定義時点でGoogle Workspace未契約という制約下での割り切り。詳細は [requestment.md](docs/requirements/requestment.md) 2章）
- 検証可能な程度の完成度を出口として開発したプロトタイプであり、本番の業務システムとしての運用は想定していない

## ライセンス
MIT License
