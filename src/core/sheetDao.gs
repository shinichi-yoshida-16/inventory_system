/**
 * データアクセス層: 全シートへの読み書き関数群
 * 参照: architecture/database.md
 *
 * 事前設定(スクリプトプロパティ):
 *   SPREADSHEET_ID - DBとして使うGoogleスプレッドシートのID
 *                     (未設定の場合はコンテナバインド前提でアクティブなスプレッドシートを使用)
 *
 * シート名はそれぞれ以下と一致していること(A1にヘッダー行):
 *   InventoryMaster / TransactionLog / NotificationTargets / AllowList
 */

var SHEET_NAMES_ = {
  INVENTORY: 'InventoryMaster',
  TRANSACTION: 'TransactionLog',
  NOTIFICATION: 'NotificationTargets',
  ALLOW: 'AllowList'
};

// DB用スプレッドシートを取得する。SPREADSHEET_ID未設定時はコンテナバインド前提でアクティブシートを返す。
function getSpreadsheet_() {
  var ssId = PropertiesService.getScriptProperties().getProperty('YOUR_SPREADSHEET_ID');
  return ssId ? SpreadsheetApp.openById(ssId) : SpreadsheetApp.getActiveSpreadsheet();
}

// 指定シート名のSheetオブジェクトを取得する。存在しない場合は例外を投げる。
function getSheet_(sheetName) {
  var sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error('シートが見つかりません: ' + sheetName);
  return sheet;
}

// ---- InventoryMaster ----
// 列定義(database.md 1章 / 同ファイル末尾ERダイアグラム準拠): A itemId, B itemName,
// C currentStock, D threshold, E alertSentFlag, F location, G discontinuedFlag, H updatedAt

// InventoryMasterの1行(配列)を、コード内で扱うitemIdベースのオブジェクトに変換する。
function rowToInventoryItem_(row, rowIndex) {
  return {
    itemId: row[0],
    itemName: row[1],
    currentStock: row[2],
    threshold: row[3],
    alertSentFlag: row[4] === true,
    location: row[5],
    discontinuedFlag: row[6] === true,
    updatedAt: row[7],
    rowIndex: rowIndex
  };
}

// InventoryMasterの全データ行を取得し、品目オブジェクトの配列として返す(0件ならば空配列)。
function getAllInventoryItems_() {
  var sheet = getSheet_(SHEET_NAMES_.INVENTORY);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  return values.map(function (row, i) {
    return rowToInventoryItem_(row, i + 2);
  });
}

// itemId(A列)でInventoryMasterを線形探索し、一致行を品目オブジェクトで返す。無ければnull。
function findInventoryRowById_(itemId) {
  var sheet = getSheet_(SHEET_NAMES_.INVENTORY);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(itemId)) {
      var rowIndex = i + 2;
      var row = sheet.getRange(rowIndex, 1, 1, 8).getValues()[0];
      return rowToInventoryItem_(row, rowIndex);
    }
  }
  return null;
}

// 新規品目1件をInventoryMaster末尾に追加する(H列の更新年月日は自動付与)。戻り値なし。
// itemIdはJANコード由来のGTIN等、数字のみの文字列になり得る。appendRow()でそのまま書き込むと
// スプレッドシートの自動型変換で数値化され、先頭の0が失われて以後の文字列一致検索が壊れるため、
// 書き込み前にA列をプレーンテキスト書式にしてから値を設定する。
function appendInventoryRow_(item) {
  var sheet = getSheet_(SHEET_NAMES_.INVENTORY);
  var rowIndex = sheet.getLastRow() + 1;
  sheet.getRange(rowIndex, 1).setNumberFormat('@');
  sheet.getRange(rowIndex, 1, 1, 8).setValues([[
    item.itemId,
    item.itemName,
    item.currentStock,
    item.threshold,
    item.alertSentFlag,
    item.location || '',
    item.discontinuedFlag,
    new Date()
  ]]);
}

// 指定行(rowIndex)のInventoryMasterを部分更新する。fieldsに含まれる列のみ書き換え、
// H列(更新年月日)は呼び出しの都度必ず現在時刻に更新する。
function updateInventoryRow_(rowIndex, fields) {
  var sheet = getSheet_(SHEET_NAMES_.INVENTORY);
  var colMap = {
    itemName: 2,
    currentStock: 3,
    threshold: 4,
    alertSentFlag: 5,
    location: 6,
    discontinuedFlag: 7
  };
  Object.keys(fields).forEach(function (key) {
    if (colMap[key]) sheet.getRange(rowIndex, colMap[key]).setValue(fields[key]);
  });
  sheet.getRange(rowIndex, 8).setValue(new Date());
}

// 既存の "PART-000123" 形式のitemIdから最大連番を求め、次の6桁連番IDを発行する。
// issueQr()内でLockService取得済みの状態から呼ばれる前提(採番の競合防止)。
function generateNextItemId_() {
  var sheet = getSheet_(SHEET_NAMES_.INVENTORY);
  var lastRow = sheet.getLastRow();
  var maxSeq = 0;
  if (lastRow >= 2) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    ids.forEach(function (row) {
      var m = /^PART-(\d{6})$/.exec(String(row[0]));
      if (m) {
        var n = parseInt(m[1], 10);
        if (n > maxSeq) maxSeq = n;
      }
    });
  }
  var next = maxSeq + 1;
  return 'PART-' + ('000000' + next).slice(-6);
}

// ---- TransactionLog(追記専用: INSERT ONLY) ----
// 列定義: A transactionAt, B itemId, C type(IN/OUT), D quantity, E userEmail

// 入出庫履歴を1行追記する。既存行の更新・削除は行わない(監査ログ性を担保するための設計、database.md 2章)。
// itemId列(B)はappendInventoryRow_と同じ理由で、書き込み前にプレーンテキスト書式にする
// (GTIN等の数字のみの文字列で先頭の0が失われるのを防ぐ)。
function appendTransactionLog_(itemId, type, quantity, userEmail) {
  var sheet = getSheet_(SHEET_NAMES_.TRANSACTION);
  var rowIndex = sheet.getLastRow() + 1;
  sheet.getRange(rowIndex, 2).setNumberFormat('@');
  sheet.getRange(rowIndex, 1, 1, 5).setValues([[new Date(), itemId, type, quantity, userEmail]]);
}

// ---- NotificationTargets ----
// 列定義: A targetId, B email, C updatedAt

// NotificationTargetsの全行を { targetId, email, updatedAt } の配列として取得する(空メール行は除外)。
function getNotificationTargets_() {
  var sheet = getSheet_(SHEET_NAMES_.NOTIFICATION);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  return values
    .map(function (row) {
      return { targetId: row[0], email: row[1], updatedAt: row[2] };
    })
    .filter(function (t) {
      return t.email;
    });
}

// 登録済み通知先メールアドレスのみを配列で取得する(アラート送信の宛先リスト用)。
function getNotificationEmails_() {
  return getNotificationTargets_().map(function (t) {
    return t.email;
  });
}

// NotificationTargetsの既存データ行を全削除し、渡されたメールアドレス配列(重複除去済み)で
// 全件洗い替えする。GF-05の通知先編集を単純なフル置換で実現するための関数。
function replaceNotificationTargets_(emails) {
  var sheet = getSheet_(SHEET_NAMES_.NOTIFICATION);
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 3).clearContent();
  }
  var now = new Date();
  var uniqueEmails = [];
  emails.forEach(function (email) {
    var normalized = String(email || '').trim();
    if (normalized && uniqueEmails.indexOf(normalized) === -1) uniqueEmails.push(normalized);
  });
  var rows = uniqueEmails.map(function (email, i) {
    return ['NTF-' + ('000' + (i + 1)).slice(-3), email, now];
  });
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  }
}

// ---- AllowList ----
// 列定義: A allowId, B email, C targetId(管理者のみ設定, database.md 4章), D retiredFlag, E updatedAt

// メールアドレス(小文字化して比較)でAllowListを線形探索する。ログイン判定・管理者判定の基点。
// 一致行が無ければnullを返す(=許可リスト未登録としてログイン拒否)。
function findAllowListByEmail_(email) {
  var sheet = getSheet_(SHEET_NAMES_.ALLOW);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var values = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  for (var i = 0; i < values.length; i++) {
    var rowEmail = String(values[i][1] || '').trim().toLowerCase();
    if (rowEmail === email) {
      return {
        allowId: values[i][0],
        email: values[i][1],
        targetId: values[i][2],
        retiredFlag: values[i][3] === true,
        updatedAt: values[i][4],
        rowIndex: i + 2
      };
    }
  }
  return null;
}
