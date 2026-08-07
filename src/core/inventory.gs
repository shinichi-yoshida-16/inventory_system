/**
 * ロジック層: 在庫増減・閾値判定・QR発行・廃番管理
 * 参照: requirements/requestment.md 4章, architecture/sequence.md 2章
 */

var LOCK_TIMEOUT_MS_ = 10000; // 10秒(要件定義10章 ロック取得タイムアウト対応)

// DAOのInventoryMasterオブジェクトからrowIndex(内部専用)を除いた、クライアント公開用の形に変換する。
// updatedAtはシート由来の生のDateオブジェクトのため、google.script.runの配列内シリアライズが
// 不安定になるのを避けるためISO文字列化してから返す。
function toPublicItem_(item) {
  return {
    itemId: item.itemId,
    itemName: item.itemName,
    currentStock: item.currentStock,
    threshold: item.threshold,
    alertSentFlag: item.alertSentFlag,
    location: item.location,
    discontinuedFlag: item.discontinuedFlag,
    updatedAt: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt
  };
}

/**
 * action: getInventoryList
 * request: { token, includeDiscontinued? }
 * 廃番品目はFR-11に基づき論理削除として扱い、管理者がincludeDiscontinuedを
 * 指定した場合のみ一覧に含める。
 */
function getInventoryList(request) {
  var auth = requireAuth_(request);
  if (!auth) return errorResponse_('セッションが切れました。再度ログインしてください。', 'TOKEN_INVALID');

  var items = getAllInventoryItems_();
  var includeDiscontinued = auth.isAdmin && !!(request && request.includeDiscontinued);
  if (!includeDiscontinued) {
    items = items.filter(function (item) {
      return !item.discontinuedFlag;
    });
  }

  return okResponse_('', { items: items.map(toPublicItem_) });
}

/**
 * action: getItemById(GF-03 コード読取直後)
 * request: { token, itemId }
 * 未登録の場合はcode:ITEM_NOT_FOUNDを付与し、クライアント側で新規登録フォームへの
 * 分岐に使えるようにする(scanProcess側でも同じ未登録判定を行い、実際の登録はそちらで行う)。
 */
function getItemById(request) {
  var auth = requireAuth_(request);
  if (!auth) return errorResponse_('セッションが切れました。再度ログインしてください。', 'TOKEN_INVALID');

  var itemId = request && request.itemId;
  if (!itemId) return errorResponse_('品目IDが指定されていません。');

  var item = findInventoryRowById_(itemId);
  if (!item) return errorResponse_('未登録の品目です。', 'ITEM_NOT_FOUND');

  return okResponse_('', { item: toPublicItem_(item) });
}

/**
 * action: scanProcess(GF-03 入出庫登録, FR-06/FR-07/FR-09を1トランザクションで処理)
 * request: { token, itemId, type: 'IN'|'OUT', quantity, itemName?, threshold?, location? }
 *
 * itemIdが未登録の場合、itemName付きで呼ばれれば「新規登録+初回入庫」を同一ロック内で
 * 原子的に行う(メーカー品のバーコード/GTIN読み取りで、未登録品を都度スキャン→登録できるようにする対応)。
 * itemNameが無ければITEM_NOT_FOUNDを返し、クライアント側に登録情報の入力を促す。
 */
function scanProcess(request) {
  var auth = requireAuth_(request);
  if (!auth) return errorResponse_('セッションが切れました。再度ログインしてください。', 'TOKEN_INVALID');

  var itemId = request && request.itemId;
  var type = request && request.type;
  var quantity = Number(request && request.quantity);
  var newItemName = request && request.itemName ? String(request.itemName).trim() : '';
  var newThreshold = request && request.threshold !== undefined ? Number(request.threshold) : 0;
  var newLocation = request && request.location ? String(request.location).trim() : '';

  if (!itemId || (type !== 'IN' && type !== 'OUT') || !(quantity > 0)) {
    return errorResponse_('入力内容が不正です。品目・種別・数量をご確認ください。');
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
    return errorResponse_('只今混み合っています。しばらくしてから再度お試しください。');
  }

  var item, newStock, wasAlerted, willAlert, isNewItem;
  try {
    item = findInventoryRowById_(itemId);
    isNewItem = !item;

    if (isNewItem) {
      if (!newItemName) {
        return errorResponse_('未登録の品目です。品目名を入力して登録してください。', 'ITEM_NOT_FOUND');
      }
      if (type !== 'IN') {
        return errorResponse_('未登録の品目は出庫できません。まず入庫として登録してください。');
      }
      if (!(newThreshold >= 0)) {
        return errorResponse_('閾値は0以上の数値で入力してください。');
      }
      appendInventoryRow_({
        itemId: itemId,
        itemName: newItemName,
        currentStock: 0,
        threshold: newThreshold,
        alertSentFlag: false,
        location: newLocation,
        discontinuedFlag: false
      });
      item = findInventoryRowById_(itemId);
    }

    if (item.discontinuedFlag) return errorResponse_('廃番の品目です。入出庫できません。');

    newStock = type === 'OUT' ? item.currentStock - quantity : item.currentStock + quantity;
    if (type === 'OUT' && newStock < 0) {
      return errorResponse_('在庫数が不足しています。');
    }

    wasAlerted = item.alertSentFlag;
    willAlert = wasAlerted;
    var fields = { currentStock: newStock };

    if (type === 'OUT') {
      if (newStock <= item.threshold && !wasAlerted) {
        willAlert = true;
        fields.alertSentFlag = true;
      }
    } else {
      if (newStock > item.threshold && wasAlerted) {
        willAlert = false;
        fields.alertSentFlag = false;
      }
    }

    updateInventoryRow_(item.rowIndex, fields);
    appendTransactionLog_(itemId, type, quantity, auth.email);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  // ロック解放後にメール送信(sequence.md 2.1 準拠。送信失敗は在庫更新結果に影響させない)
  if (type === 'OUT' && willAlert && !wasAlerted) {
    sendThresholdAlert_(item.itemId, item.itemName, newStock, item.threshold);
  }

  var message = isNewItem
    ? '新規品目として登録し、入庫を記録しました。'
    : type === 'OUT'
    ? '出庫を登録しました。'
    : '入庫を登録しました。';
  return okResponse_(message, { itemId: itemId, currentStock: newStock, isNewItem: isNewItem });
}

/**
 * action: issueQr(GF-04 新規品目登録・QRコード発行)
 * request: { token, itemName, threshold, location? }
 */
function issueQr(request) {
  var auth = requireAuth_(request);
  if (!auth) return errorResponse_('セッションが切れました。再度ログインしてください。', 'TOKEN_INVALID');

  var itemName = String((request && request.itemName) || '').trim();
  var threshold = Number(request && request.threshold);
  var location = String((request && request.location) || '').trim();

  if (!itemName) return errorResponse_('品目名を入力してください。');
  if (!(threshold >= 0)) return errorResponse_('閾値は0以上の数値で入力してください。');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
    return errorResponse_('只今混み合っています。しばらくしてから再度お試しください。');
  }

  var itemId;
  try {
    itemId = generateNextItemId_();
    appendInventoryRow_({
      itemId: itemId,
      itemName: itemName,
      currentStock: 0,
      threshold: threshold,
      alertSentFlag: false,
      location: location,
      discontinuedFlag: false
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  return okResponse_('品目を登録しました。', { itemId: itemId, itemName: itemName });
}

/**
 * action: updateThreshold(GF-05)
 * request: { token, itemId?, threshold?, notificationEmails? }
 * itemId+threshold指定で品目ごとの閾値を更新し、notificationEmails指定で
 * 通知先メールアドレス一覧(全件置き換え)を更新する。両方省略不可。
 */
function updateThreshold(request) {
  var auth = requireAuth_(request);
  if (!auth) return errorResponse_('セッションが切れました。再度ログインしてください。', 'TOKEN_INVALID');

  var itemId = request && request.itemId;
  var hasItemUpdate = !!itemId;
  var hasEmailUpdate = !!(request && Array.isArray(request.notificationEmails));

  if (!hasItemUpdate && !hasEmailUpdate) {
    return errorResponse_('更新内容がありません。');
  }

  var threshold = Number(request && request.threshold);
  if (hasItemUpdate && !(threshold >= 0)) {
    return errorResponse_('閾値は0以上の数値で入力してください。');
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
    return errorResponse_('只今混み合っています。しばらくしてから再度お試しください。');
  }

  try {
    if (hasItemUpdate) {
      var item = findInventoryRowById_(itemId);
      if (!item) return errorResponse_('対象の品目が見つかりません。');
      updateInventoryRow_(item.rowIndex, { threshold: threshold });
    }
    if (hasEmailUpdate) {
      replaceNotificationTargets_(request.notificationEmails);
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  return okResponse_('更新しました。', {
    itemId: hasItemUpdate ? itemId : null,
    threshold: hasItemUpdate ? threshold : null
  });
}

/**
 * action: getNotificationTargets(GF-05 初期表示用)
 * request: { token }
 */
function getNotificationTargets(request) {
  var auth = requireAuth_(request);
  if (!auth) return errorResponse_('セッションが切れました。再度ログインしてください。', 'TOKEN_INVALID');

  return okResponse_('', { emails: getNotificationEmails_() });
}

/**
 * action: setDiscontinued(GF-02, 管理者のみ, FR-11)
 * request: { token, itemId, discontinued }
 */
function setDiscontinued(request) {
  var auth = requireAuth_(request);
  if (!auth) return errorResponse_('セッションが切れました。再度ログインしてください。', 'TOKEN_INVALID');
  if (!auth.isAdmin) return errorResponse_('この操作には管理者権限が必要です。');

  var itemId = request && request.itemId;
  var discontinued = !!(request && request.discontinued);
  if (!itemId) return errorResponse_('品目IDを指定してください。');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
    return errorResponse_('只今混み合っています。しばらくしてから再度お試しください。');
  }

  try {
    var item = findInventoryRowById_(itemId);
    if (!item) return errorResponse_('対象の品目が見つかりません。');
    updateInventoryRow_(item.rowIndex, { discontinuedFlag: discontinued });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  return okResponse_(discontinued ? '廃番に設定しました。' : '廃番設定を解除しました。', {
    itemId: itemId,
    discontinuedFlag: discontinued
  });
}
