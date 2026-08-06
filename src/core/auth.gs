/**
 * ロジック層: ログイン判定・セッショントークンの発行/検証
 * 参照: architecture/sequence.md 1章, architecture/database.md 4章
 */

var TOKEN_TTL_SECONDS_ = 1800; // 30分

/**
 * action: login
 * request: { email }
 */
function login(request) {
  var email = String((request && request.email) || '').trim().toLowerCase();
  if (!email) return errorResponse_('メールアドレスを入力してください。');

  var allow = findAllowListByEmail_(email);
  if (!allow || allow.retiredFlag) {
    return errorResponse_('ログインできませんでした。利用許可がありません。管理者にお問い合わせください。');
  }

  var isAdmin = !!allow.targetId;
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put(
    token,
    JSON.stringify({ email: email, isAdmin: isAdmin }),
    TOKEN_TTL_SECONDS_
  );

  return okResponse_('ログインしました。', { token: token, email: email, isAdmin: isAdmin });
}

/**
 * トークンを検証し、有効なら { email, isAdmin } を返す。無効・期限切れならnull。
 */
function verifyToken_(token) {
  if (!token) return null;
  var raw = CacheService.getScriptCache().get(token);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

// リクエストからtokenを取り出して検証する共通ガード。各actionハンドラの冒頭で使う。
function requireAuth_(request) {
  return verifyToken_(request && request.token);
}
