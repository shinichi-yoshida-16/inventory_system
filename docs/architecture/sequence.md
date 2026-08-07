# セッション・トークン設計 / シーケンス設計
- 対象システム：整備部品在庫管理システム
- 本書の位置付け：セッション設計・処理フローの詳細設計
- 前提：GAS Web App と 外部ホスティング（GF-03）の2ドメイン構成

---

## 1. セッション・トークン設計
### 1.1 トークンのライフサイクル

```mermaid
sequenceDiagram
    participant U as 利用者
    participant GF00 as GF-00(GAS)
    participant Cache as CacheService
    participant GF01 as GF-01/02等(GAS)
    participant GF03 as GF-03(外部ホスティング)

    U->>GF00: メールアドレス入力
    GF00->>GF00: 許可リスト照合(許可ID/退職フラグ)
    GF00->>Cache: トークン発行・保存(有効期限30分)
    Cache-->>GF00: token
    GF00-->>U: トークンをクライアントJS変数に保持
    U->>GF01: 画面遷移（同一ドメイン、トークン保持のまま）
    U->>GF03: GF-03へ遷移（URLパラメータで token を付与）
    GF03->>GF03: token をJS変数に保持
    GF03->>GF00: doPost(action, token, ...)
    GF00->>Cache: token検証
    alt token有効
        Cache-->>GF00: 検証OK
        GF00-->>GF03: status:OK
    else token無効／期限切れ
        Cache-->>GF00: 検証NG
        GF00-->>GF03: status:ERROR "再ログインしてください"
        GF03-->>U: GF-00へ誘導
    end
```

### 1.2 設計上の要点（要件定義10章リスクへの対応方針を具体化）

- 有効期限：30分固定。`CacheService.getScriptCache().put(token, email, 1800)`
- GF-03への引き継ぎはURLパラメータ（`?token=xxx`）とする。漏えいリスクへの対応として、
  - トークンは推測困難なランダム文字列（UUID等）とし、メールアドレス等の個人情報を直接含めない
  - 使用の都度、CacheServiceで有効性を検証する（1.1のalt分岐）
  - ブラウザ履歴に残るリスクは許容リスクとして要件定義NR-03同様に明文化する
- なりすまし対策は行わない（要件定義NR-03の許容リスクを踏襲）

---

## 2. シーケンス設計
### 2.1 出庫処理シーケンス（GF-03起点、FR-06・FR-09該当）

```mermaid
sequenceDiagram
    participant U as 整備士(スマホ)
    participant GF03 as GF-03(外部ホスティング)
    participant API as doPost(GAS API層)
    participant Logic as InvLogic(ロジック層)
    participant Lock as LockService
    participant DAO as SheetDao
    participant SS as スプレッドシート
    participant Mail as GmailApp

    U->>GF03: QRコード読取
    GF03->>API: doPost(action=getItemById)
    API-->>GF03: 品目情報返却
    U->>GF03: 出庫数量入力・登録押下
    GF03->>API: doPost(action=scanProcess, type=OUT, quantity)
    API->>Logic: 出庫処理を委譲
    Logic->>Lock: getScriptLock()
    Lock-->>Logic: ロック取得
    Logic->>DAO: 在庫マスタ取得(itemId)
    DAO->>SS: 読み取り
    SS-->>DAO: 現在在庫数
    Logic->>Logic: 在庫数 -= quantity
    Logic->>DAO: 在庫マスタ更新
    Logic->>DAO: 入出庫履歴に1行追加(操作者=email)
    DAO->>SS: 書き込み
    Logic->>SS: SpreadsheetApp.flush()
    Logic->>Logic: 閾値と比較 → 送信要否をフラグに反映(この時点でアラート送信済みフラグも確定させる)
    Logic->>Lock: releaseLock()
    alt 閾値を下回った(在庫数 <= 閾値) かつ 送信要
        Logic->>Mail: GmailApp.sendEmail() ※try-catch、失敗してもここで処理終了
    end    
    Logic-->>API: 処理結果(現在在庫数)
    API-->>GF03: status:OK, data
    GF03-->>U: 完了表示(次画面にとどまる)
```

### 2.2 入庫処理シーケンス（FR-07該当）の差分

出庫と同一のトランザクション構造（2.1と同じ流れ）だが、以下が異なる。

- 在庫数は `+= quantity`
- 閾値判定は「入庫後に閾値以上(在庫数 > 閾値)へ回復したか」を見る
- 回復した場合、送信済みフラグを `true → false` に戻す（再度閾値を下回った際に再通知できるようにする）

### 2.3 排他制御の要点（技術検証結果の反映）

- `LockService.getScriptLock()` を在庫更新の開始時に取得し、シート書き込み完了後・ロック解放前に必ず `SpreadsheetApp.flush()` を呼ぶ（要件定義6章の検証済み注意点）
- ロック取得タイムアウト（例：10秒）を設定し、失敗時は `status:ERROR` を返してクライアント側でリトライ導線を表示する（要件定義10章リスク「通信失敗」対応。詳細は `全体設計書.md` エラーハンドリング方針参照）

### 2.4 ログインシーケンス（1.1と対応）

ログイン自体のシーケンスは「1.1 トークンのライフサイクル」と同一フローのため、本節では重複させず1.1を参照する。

### 2.5 未登録品目スキャン時の自動登録シーケンス（FR-12該当）

```mermaid
sequenceDiagram
    participant U as 整備士(スマホ)
    participant GF03 as GF-03(外部ホスティング)
    participant API as doPost(GAS API層)
    participant Logic as InvLogic(ロジック層)
    participant Lock as LockService
    participant DAO as SheetDao
    participant SS as スプレッドシート

    U->>GF03: コード読取(JAN/DataMatrix/QR等)
    GF03->>GF03: フォーマット判定・itemId抽出(全体設計書.md 4.5節)
    GF03->>API: doPost(action=getItemById, itemId)
    API->>Logic: 品目検索を委譲
    Logic->>DAO: findInventoryRowById_(itemId)
    DAO->>SS: 読み取り
    SS-->>DAO: 該当なし
    Logic-->>API: status:ERROR, code:ITEM_NOT_FOUND
    API-->>GF03: 未登録
    GF03-->>U: 新規登録フォーム表示(品目名・閾値・保管場所)
    U->>GF03: 登録情報入力・登録押下
    GF03->>API: doPost(action=scanProcess, type=IN, quantity=1, itemName, threshold, location)
    API->>Logic: 登録+入庫処理を委譲
    Logic->>Lock: getScriptLock()
    Lock-->>Logic: ロック取得
    Logic->>DAO: findInventoryRowById_(itemId) ※未登録を再確認
    Logic->>DAO: 在庫マスタへ新規行追加(currentStock=0で仮作成)
    DAO->>SS: 書き込み
    Logic->>Logic: 在庫数 0 += 1 (通常の入庫処理と同じ計算式に合流)
    Logic->>DAO: 在庫マスタ更新
    Logic->>DAO: 入出庫履歴に1行追加(種別=IN, 操作者=email)
    DAO->>SS: 書き込み
    Logic->>SS: SpreadsheetApp.flush()
    Logic->>Lock: releaseLock()
    Logic-->>API: 処理結果(現在在庫数=1)
    API-->>GF03: status:OK, data
    GF03-->>U: 登録完了表示
```

- 「未登録判定」から「新規行追加」までを同一のLockService区間内で行うことで、確認(`getItemById`)と登録(`scanProcess`)の間に別ユーザーの操作が割り込むレース条件を避ける。`getItemById`での未登録判定はあくまで画面分岐用の参考情報であり、実際の登録可否は`scanProcess`内で再判定する
- 新規登録時は種別を`IN`固定とし、`OUT`は拒否する(存在しない品目からの出庫を防止するため)
- 登録済み品目の通常の入出庫は2.1・2.2のシーケンスと同一のまま変更なし(識別コードの取得元がQRかJAN/DataMatrixかを問わない)