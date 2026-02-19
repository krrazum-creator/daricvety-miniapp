const BOT_TOKEN = "8082378383:AAF_b13HkvS4uY0kokzgEnv33FWTGaeafuQ";
const MANAGER_CHAT_ID = 490214071;

const SUPPORT_USERNAME = "chaiori";
const MINIAPP_URL = "https://daricvety-miniapp.vercel.app/";
const WELCOME_BONUS = 500;

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) ? e.parameter.action : "";
  if (action === "products") return getProducts();
  return jsonOut({ status: "ok", message: "api works" });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return jsonOut({ status: "error", error: "no data" });
    const data = JSON.parse(e.postData.contents);

    if (isTelegramUpdate(data)) {
      if (!isDuplicateUpdate(data)) handleTelegramUpdate(data);
      return jsonOut({ ok: true });
    }

    if (data && data.action === "create_order") return createOrder(data);
    if (data && data.action === "get_profile") return getProfile(data);

    return jsonOut({ status: "error", error: "unknown request" });
  } catch (err) {
    Logger.log("doPost error: " + err);
    return jsonOut({ status: "error", error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getProducts() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Products");
  if (!sheet) return jsonOut({ status: "error", error: "products sheet not found" });

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return jsonOut({ status: "ok", products: [] });

  const headers = values[0].map(h => String(h).trim());
  const rows = values.slice(1);
  const idx = (name) => headers.indexOf(name);

  const iId = idx("id");
  const iName = idx("name");
  const iCategory = idx("category");
  const iPrice = idx("price");
  const iPhoto1 = idx("photo1");
  const iPhoto2 = idx("photo2");
  const iPhoto3 = idx("photo3");
  const iDesc = idx("description");
  const iActive = idx("active");
  const iSort = idx("sort");

  const products = rows
    .map(r => {
      const activeRaw = iActive >= 0 ? r[iActive] : true;
      const isActive = String(activeRaw).toLowerCase() === "true" || activeRaw === true;
      if (!isActive) return null;

      const photos = [];
      if (iPhoto1 >= 0 && r[iPhoto1]) photos.push(String(r[iPhoto1]).trim());
      if (iPhoto2 >= 0 && r[iPhoto2]) photos.push(String(r[iPhoto2]).trim());
      if (iPhoto3 >= 0 && r[iPhoto3]) photos.push(String(r[iPhoto3]).trim());

      return {
        id: iId >= 0 ? String(r[iId]).trim() : "",
        name: iName >= 0 ? String(r[iName]).trim() : "",
        category: iCategory >= 0 ? String(r[iCategory]).trim() : "",
        price: iPrice >= 0 ? Number(r[iPrice]) : 0,
        photos,
        description: iDesc >= 0 ? String(r[iDesc]).trim() : "",
        sort: iSort >= 0 ? Number(r[iSort]) : 0
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.sort || 0) - (b.sort || 0));

  return jsonOut({ status: "ok", products });
}

function getProfile(data) {
  const profile = getOrCreateCustomerProfile_(data || {});
  return jsonOut({
    status: "ok",
    tg_user_id: profile.tg_user_id,
    bonus_balance: Number(profile.bonus_balance || 0),
    is_new: !!profile.just_created
  });
}

function createOrder(data) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Orders");
    if (!sheet) return jsonOut({ status: "error", error: "orders sheet not found" });

    const profile = getOrCreateCustomerProfile_(data || {});

    const orderId = "ORD" + new Date().getTime();
    const createdAt = new Date();

    const itemsArr = Array.isArray(data.items) ? data.items : [];
    const itemsJson = JSON.stringify(itemsArr);

    const needCallback = !!data.need_callback;
    const clarifyAddressRecipient = !!data.clarify_address_recipient;
    const useBonuses = !!data.use_bonuses;

    const subtotal = Number(data.total || 0) || 0;
    const available = Number(profile.bonus_balance || 0) || 0;
    const bonusUsed = useBonuses ? Math.max(0, Math.min(available, subtotal)) : 0;
    const totalAfterBonus = Math.max(0, subtotal - bonusUsed);

    appendOrderRowByHeaders(sheet, {
      createdAt,
      orderId,
      tg_user_id: data.tg_user_id || "",
      tg_username: data.tg_username || "",
      tg_first_name: data.tg_first_name || "",
      tg_last_name: data.tg_last_name || "",
      customer_name: data.customer_name || "",
      customer_phone: data.customer_phone || "",
      recipient_name: data.recipient_name || "",
      recipient_phone: data.recipient_phone || "",
      same_as_customer: !!data.same_as_customer ? "yes" : "no",
      address: data.address || "",
      clarify_address_recipient: clarifyAddressRecipient ? "yes" : "no",
      date: data.date || "",
      time_slot: data.time_slot || "",
      delivery_type: data.delivery_type || "",
      delivery_price: data.delivery_price || "",
      subtotal,
      bonus_used: bonusUsed,
      total: totalAfterBonus,
      items: itemsJson,
      callback: needCallback ? "yes" : "no",
      card_not_needed: !!data.card_not_needed ? "yes" : "no",
      card_text: data.card_text || "",
      comment: data.comment || "",
      status: "new"
    });

    if (bonusUsed > 0) changeBonusBalance_(profile.tg_user_id, -bonusUsed, "order_spend", orderId);

    const freshProfile = getCustomerByTelegramId_(profile.tg_user_id);
    sendToManagerTelegram(orderId, data, {
      bonus_used: bonusUsed,
      total_after_bonus: totalAfterBonus,
      clarify_address_recipient: clarifyAddressRecipient
    });

    return jsonOut({ status: "ok", order_id: orderId, bonus_balance: Number(freshProfile.bonus_balance || 0) || 0 });
  } catch (err) {
    Logger.log("createOrder error: " + err);
    return jsonOut({ status: "error", error: String(err) });
  }
}

function appendOrderRowByHeaders(sheet, obj) {
  const lastCol = sheet.getLastColumn();
  if (lastCol <= 0) {
    sheet.appendRow(Object.values(obj));
    return;
  }

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  if (!headers || headers.length === 0) {
    sheet.appendRow(Object.values(obj));
    return;
  }

  const row = new Array(headers.length).fill("");
  const findIndex = (names) => {
    for (const n of names) {
      const i = headers.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const map = {
    createdAt: ["createdAt", "created_at"],
    orderId: ["orderId", "order_id"],
    tg_user_id: ["tg_user_id"],
    tg_username: ["tg_username"],
    tg_first_name: ["tg_first_name"],
    tg_last_name: ["tg_last_name"],
    customer_name: ["customer_name"],
    customer_phone: ["customer_phone"],
    recipient_name: ["recipient_name"],
    recipient_phone: ["recipient_phone"],
    same_as_customer: ["same_as_customer"],
    address: ["address"],
    clarify_address_recipient: ["clarify_address_recipient"],
    date: ["date"],
    time_slot: ["time_slot"],
    delivery_type: ["delivery_type"],
    delivery_price: ["delivery_price"],
    subtotal: ["subtotal"],
    bonus_used: ["bonus_used"],
    total: ["total"],
    items: ["items", "items(JSON)", "items_json"],
    callback: ["callback", "need_callback"],
    card_not_needed: ["card_not_needed"],
    card_text: ["card_text"],
    comment: ["comment"],
    status: ["status"]
  };

  const iCreated = findIndex(map.createdAt);
  if (iCreated >= 0) row[iCreated] = obj.createdAt;
  const iOrder = findIndex(map.orderId);
  if (iOrder >= 0) row[iOrder] = obj.orderId;

  Object.keys(map).forEach((key) => {
    if (key === "createdAt" || key === "orderId") return;
    const idx = findIndex(map[key]);
    if (idx >= 0) row[idx] = obj[key] ?? "";
  });

  sheet.appendRow(row);
}

function getOrCreateCustomersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Customers");
  if (!sheet) {
    sheet = ss.insertSheet("Customers");
    sheet.appendRow([
      "createdAt", "updatedAt", "tg_user_id", "tg_username", "tg_first_name", "tg_last_name",
      "customer_phone", "bonus_balance", "welcome_bonus_granted"
    ]);
  }
  return sheet;
}

function getCustomerByTelegramId_(tgUserId) {
  const uid = String(Number(tgUserId || 0));
  if (!uid || uid === "0") return null;

  const sheet = getOrCreateCustomersSheet_();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;
  const headers = values[0].map(h => String(h).trim());
  const iUid = headers.indexOf("tg_user_id");
  if (iUid < 0) return null;

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][iUid]) === uid) {
      return rowToObject_(headers, values[i], i + 1);
    }
  }
  return null;
}

function getOrCreateCustomerProfile_(data) {
  const tgUserId = Number(data.tg_user_id || 0);
  if (!tgUserId) return { tg_user_id: 0, bonus_balance: 0, just_created: false };

  const sheet = getOrCreateCustomersSheet_();
  const existing = getCustomerByTelegramId_(tgUserId);
  const now = new Date();

  if (existing) {
    updateCustomerRow_(sheet, existing.__row, {
      updatedAt: now,
      tg_username: data.tg_username || existing.tg_username || "",
      tg_first_name: data.tg_first_name || existing.tg_first_name || "",
      tg_last_name: data.tg_last_name || existing.tg_last_name || "",
      customer_phone: data.customer_phone || existing.customer_phone || ""
    });
    const fresh = getCustomerByTelegramId_(tgUserId);
    fresh.just_created = false;
    return fresh;
  }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const row = new Array(headers.length).fill("");
  const set = (key, value) => {
    const i = headers.indexOf(key);
    if (i >= 0) row[i] = value;
  };

  set("createdAt", now);
  set("updatedAt", now);
  set("tg_user_id", tgUserId);
  set("tg_username", data.tg_username || "");
  set("tg_first_name", data.tg_first_name || "");
  set("tg_last_name", data.tg_last_name || "");
  set("customer_phone", data.customer_phone || "");
  set("bonus_balance", WELCOME_BONUS);
  set("welcome_bonus_granted", "yes");

  sheet.appendRow(row);
  const created = getCustomerByTelegramId_(tgUserId);
  created.just_created = true;
  changeBonusBalance_(tgUserId, 0, "welcome_granted", "init");
  return created;
}

function updateCustomerRow_(sheet, rowNum, patch) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const row = sheet.getRange(rowNum, 1, 1, headers.length).getValues()[0];
  Object.keys(patch).forEach(k => {
    const i = headers.indexOf(k);
    if (i >= 0) row[i] = patch[k];
  });
  sheet.getRange(rowNum, 1, 1, headers.length).setValues([row]);
}

function changeBonusBalance_(tgUserId, delta, reason, ref) {
  const profile = getCustomerByTelegramId_(tgUserId);
  if (!profile) return;

  const sheet = getOrCreateCustomersSheet_();
  const current = Number(profile.bonus_balance || 0) || 0;
  const next = Math.max(0, current + Number(delta || 0));
  updateCustomerRow_(sheet, profile.__row, { bonus_balance: next, updatedAt: new Date() });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let log = ss.getSheetByName("BonusLog");
  if (!log) {
    log = ss.insertSheet("BonusLog");
    log.appendRow(["createdAt", "tg_user_id", "delta", "balance_after", "reason", "ref"]);
  }
  log.appendRow([new Date(), tgUserId, Number(delta || 0), next, reason || "", ref || ""]);
}

function rowToObject_(headers, row, rowNum) {
  const o = {};
  headers.forEach((h, i) => { o[h] = row[i]; });
  o.__row = rowNum;
  return o;
}

function sendToManagerTelegram(orderId, data, extra) {
  const userLink = buildUserLink(data);
  const userLine = userLink ? `пользователь: ${userLink}` : `пользователь: неизвестно`;
  const needCallback = !!data.need_callback;
  const needAddressClarify = !!(extra && extra.clarify_address_recipient);

  const fallbackContact = String(data.customer_phone || "").trim() || "не указан";
  const messageHtml =
`<b>новый заказ ${escapeHtml(orderId)}</b>

${userLine}
<b>telegram id:</b> ${escapeHtml(String(data.tg_user_id || "неизвестно"))}
<b>обратный звонок:</b> ${needCallback ? "да" : "нет"}
<b>уточнить адрес у получателя:</b> ${needAddressClarify ? "да" : "нет"}

<b>имя заказчика:</b> ${escapeHtml(data.customer_name)}
<b>телефон заказчика:</b> ${escapeHtml(String(data.customer_phone || ""))}
<b>имя получателя:</b> ${escapeHtml(String(data.recipient_name || ""))}
<b>телефон получателя:</b> ${escapeHtml(String(data.recipient_phone || ""))}
<b>резервный контакт:</b> ${escapeHtml(fallbackContact)}
<b>адрес:</b> ${escapeHtml(String(data.address || ""))}

<b>дата:</b> ${escapeHtml(String(data.date || ""))}
<b>интервал:</b> ${escapeHtml(String(data.time_slot || ""))}

<b>доставка:</b> ${escapeHtml(String(data.delivery_type || ""))}
<b>стоимость доставки:</b> ${escapeHtml(String(data.delivery_price || ""))}

<b>списано бонусов:</b> ${escapeHtml(String((extra && extra.bonus_used) || 0))}
<b>к оплате:</b> ${escapeHtml(String((extra && extra.total_after_bonus) || data.total || ""))}`;

  tgSendMessage(MANAGER_CHAT_ID, messageHtml, { parse_mode: "HTML", disable_web_page_preview: true });
}

function buildUserLink(data) {
  const uid = Number(data.tg_user_id || 0);
  const username = String(data.tg_username || "").trim();
  const first = String(data.tg_first_name || "").trim();
  const last = String(data.tg_last_name || "").trim();

  if (username) {
    const safe = username.replace(/^@/, "");
    const url = `https://t.me/${safe}`;
    return `<a href="${escapeAttr(url)}">@${escapeHtml(safe)}</a>`;
  }
  if (uid) {
    const name = `${first} ${last}`.trim();
    const label = name ? escapeHtml(name) : `id ${uid}`;
    return `<a href="tg://user?id=${uid}">${label}</a>`;
  }
  return "";
}

function escapeHtml(s) { return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function escapeAttr(s){ return String(s ?? "").replace(/"/g, "&quot;"); }

function isTelegramUpdate(obj) { return !!(obj && (obj.update_id || obj.message || obj.callback_query)); }
function isDuplicateUpdate(update) {
  const cur = Number(update && update.update_id ? update.update_id : 0);
  if (!cur) return false;
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty("TG_LAST_UPDATE_ID") || "0");
  if (cur <= last) return true;
  props.setProperty("TG_LAST_UPDATE_ID", String(cur));
  return false;
}
function isStartRateLimited(chatId) {
  const props = PropertiesService.getScriptProperties();
  const key = "TG_START_LAST_" + String(chatId);
  const last = Number(props.getProperty(key) || "0");
  const now = Date.now();
  if (now - last < 60 * 1000) return true;
  props.setProperty(key, String(now));
  return false;
}

function handleTelegramUpdate(update) {
  if (!update.message) return;
  const chatId = update.message.chat && update.message.chat.id;
  const text = (update.message.text || "").trim();
  if (!chatId || !text) return;

  const t = text.toLowerCase();
  if (text === "/start") {
    if (isStartRateLimited(chatId)) return;
    return sendStartSequence(chatId);
  }
  if (text === "/catalog" || t === "каталог") return sendCatalog(chatId);
  if (text === "/help" || t === "поддержка" || t.includes("помощь")) return sendHelp(chatId);
}

function getMainKeyboardMarkup() {
  return {
    keyboard: [[{ text: "каталог", web_app: { url: MINIAPP_URL } }, { text: "поддержка" }]],
    resize_keyboard: true,
    is_persistent: true
  };
}

function sendStartSequence(chatId) {
  const msg1 =
`привет!
добро пожаловать в дарицветы.москва.

откройте каталог и выберите букет — оформление занимает всего пару минут.`;

  const msg2 =
`новым пользователям начисляем 500 приветственных баллов.

их можно списать при покупке.
1 балл = 1 рубль.`;

  tgSendMessage(chatId, msg1, {});
  tgSendMessage(chatId, msg2, { reply_markup: getMainKeyboardMarkup() });
}

function sendCatalog(chatId) { tgSendMessage(chatId, "откройте каталог и выберите букет.", { reply_markup: getMainKeyboardMarkup() }); }
function sendHelp(chatId) {
  if (isSupportRateLimited(chatId)) return;
  tgSendMessage(chatId, "нажмите кнопку ниже — откроется чат поддержки.", {
    reply_markup: { inline_keyboard: [[{ text: "написать в поддержку", url: `https://t.me/${SUPPORT_USERNAME}` }]] }
  });
}
function isSupportRateLimited(chatId) {
  const props = PropertiesService.getScriptProperties();
  const key = "TG_SUPPORT_LAST_" + String(chatId);
  const last = Number(props.getProperty(key) || "0");
  const now = Date.now();
  if (now - last < 20 * 1000) return true;
  props.setProperty(key, String(now));
  return false;
}

function tgSendMessage(chatId, text, opts) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const payload = Object.assign({ chat_id: chatId, text: text }, (opts || {}));
  UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}
