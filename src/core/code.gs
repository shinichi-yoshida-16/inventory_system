/**
 * APIレイヤー: doGet/doPostのルーティングに専念する(処理本体は書かない)
 * 参照: architecture/overview.md 3章・4章
 *
 * 事前設定(スクリプトプロパティ、任意):
 *   GF03_URL - 外部無償ホスティング(GF-03 QRスキャン画面)のデプロイ先URL
 */

// ?page=GF0Xパラメータに応じたHTML Serviceページを返す。テンプレートにscriptUrl/gf03Urlを
// 埋め込み、各画面のJSがGAS本体URL・外部スキャン画面URLを組み立てられるようにする。
function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) || 'GF00';
  var fileMap = {
    GF00: 'frontend/html/GF00_login',
    GF01: 'frontend/html/GF01_dashboard',
    GF02: 'frontend/html/GF02_inventory_list',
    GF04: 'frontend/html/GF04_qr_issue',
    GF05: 'frontend/html/GF05_threshold_setting'
  };
  var file = fileMap[page] || fileMap.GF00;

  var template = HtmlService.createTemplateFromFile(file);
  template.scriptUrl = ScriptApp.getService().getUrl();
  template.gf03Url = getGf03Url_();

  return template
    .evaluate()
    .setTitle('統合部品在庫管理システム')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * GF-03(外部無償ホスティング)からのfetch専用エントリポイント。
 * Content-Type: text/plain;charset=utf-8 で送られたJSON文字列をパースし、
 * ロジック層の同名関数へディスパッチする(4.4 action一覧 参照)。
 */
function doPost(e) {
  var request;
  try {
    request = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOutput_(errorResponse_('リクエストの解析に失敗しました。'));
  }

  switch (request.action) {
    case 'login':
      return jsonOutput_(login(request));
    case 'getInventoryList':
      return jsonOutput_(getInventoryList(request));
    case 'getItemById':
      return jsonOutput_(getItemById(request));
    case 'scanProcess':
      return jsonOutput_(scanProcess(request));
    case 'issueQr':
      return jsonOutput_(issueQr(request));
    case 'updateThreshold':
      return jsonOutput_(updateThreshold(request));
    case 'getNotificationTargets':
      return jsonOutput_(getNotificationTargets(request));
    case 'setDiscontinued':
      return jsonOutput_(setDiscontinued(request));
    default:
      return jsonOutput_(errorResponse_('不明なactionです: ' + request.action));
  }
}

// HTMLテンプレート内の <?!= include('...'); ?> から呼ばれる、部分HTML(css/js)埋め込み用ヘルパー。
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// GF-03(外部無償ホスティング)のURLをスクリプトプロパティから取得する。未設定時は空文字。
function getGf03Url_() {
  return PropertiesService.getScriptProperties().getProperty('GF03_URL') || '';
}

// ロジック層の戻り値オブジェクトをJSON文字列化し、doPost用のTextOutputへ変換する。
function jsonOutput_(responseObj) {
  return ContentService.createTextOutput(JSON.stringify(responseObj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

// 統一レスポンス形式(status:"OK")を組み立てる(overview.md 4.3 レスポンス仕様準拠)。
function okResponse_(message, data) {
  return { status: 'OK', message: message || '', data: data || null };
}

// 統一レスポンス形式(status:"ERROR")を組み立てる。codeはクライアント側の分岐用(例: TOKEN_INVALID)。
function errorResponse_(message, code) {
  return {
    status: 'ERROR',
    message: message || 'エラーが発生しました。',
    data: code ? { code: code } : null
  };
}
