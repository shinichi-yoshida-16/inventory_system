/**
 * ロジック層: 在庫アラートメール送信
 * 参照: requirements/requestment.md FR-09, architecture/overview.md 5章 FE-04
 */

/**
 * 閾値を下回った際の通知メールを、登録済み全通知先へ一律送信する。
 * 送信失敗時も在庫更新処理自体は継続させるため、呼び出し側で捕捉できない例外は
 * ここで握りつぶし、ログにのみ残す(FE-04)。
 */
function sendThresholdAlert_(itemId, itemName, currentStock, threshold) {
  try {
    var emails = getNotificationEmails_();
    if (!emails.length) return;

    var subject = '[在庫アラート] ' + itemName + ' が閾値を下回りました';
    var body = [
      '以下の品目が設定された閾値を下回りました。補充をご検討ください。',
      '',
      '品目ID: ' + itemId,
      '品目名: ' + itemName,
      '現在在庫数: ' + currentStock,
      'アラート閾値: ' + threshold
    ].join('\n');

    emails.forEach(function (email) {
      try {
        GmailApp.sendEmail(email, subject, body);
      } catch (innerErr) {
        console.error('アラートメール送信に失敗しました(' + email + '): ' + innerErr);
      }
    });
  } catch (err) {
    console.error('アラートメール送信処理でエラーが発生しました: ' + err);
  }
}
