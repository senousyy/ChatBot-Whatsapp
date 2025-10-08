const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

const app = express();
const PORT = 3000;

// --- اضبط القيم دي --- //
const ULTRA_INSTANCE_ID = "instance142984";
const ULTRA_TOKEN = "799w3nqqj4fbwxt9";
const ULTRA_SEND_URL = `https://api.ultramsg.com/${ULTRA_INSTANCE_ID}/messages/chat`;

const SARWA_API_BASE = "https://sl-portal.sarwa.insurance/ords/sl_ws/MEMBERS";
const SARWA_LOG_API = "https://sl-portal.sarwa.insurance/ords/sl_ws/discussion/messages"; 
const SECRET_KEY = "your_super_secret_key_here_change_this"; // غير هذا لمفتاح سري قوي وآمن
// ---------------------- //

app.use(bodyParser.json());

// تخزين الـ hashes اللي تم معالجتها لمنع التكرار
const processedMessages = new Set();
// تخزين المستخدمين اللي تم الترحيب بيهم
const welcomedUsers = new Set();
// تخزين بيانات المستخدمين اللي اتحققوا
const verifiedUsers = new Map();

// للتأكد من ان السيرفر شغال
app.get("/", (req, res) => res.send("✅ Server is running"));

// Webhook endpoint
app.post("/ultramsgwebhook", async (req, res) => {
  try {
    console.log("📩 Incoming Webhook (trim):", JSON.stringify(req.body).slice(0, 1500));

    const data = req.body.data || req.body;
    const from = data.from;                 
    const rawBody = (data.body || "").toString().trim();
    const messageHash = req.body.hash; // الـ hash بتاع الرسالة

    console.log("👤 From:", from);
    console.log("💬 Body:", rawBody);
    console.log("🔑 Hash:", messageHash);

    // تنظيف رقم التليفون من @c.us
    const cleanFrom = from.split('@')[0];

    // 1. التحقق من إن الرسالة مش مكررة
    if (processedMessages.has(messageHash)) {
      console.log("🔄 Duplicate message ignored, hash:", messageHash);
      return res.sendStatus(200);
    }
    processedMessages.add(messageHash);

    // 2. سجل رسالة العميل
    await logMessage({
      member_id: null,
      message: rawBody,
      sender: "USER",
      user_number: cleanFrom
    });

    // 3. لو العميل اتحقق
    if (verifiedUsers.has(from)) {
      // التأكد إن الإدخال هو 1, 2, أو 3
      if (["1", "2", "3"].includes(rawBody)) {
        const userData = verifiedUsers.get(from);
        const memberId = userData.memberId;
        const cleanUserNumber = userData.userNumber.split('@')[0]; // إزالة @c.us
        let reply = "";

        if (rawBody === "1" || rawBody === "2") {
          const secureToken = createSecureToken(memberId, cleanUserNumber);
          const uploadUrl = `https://sl-portal.sarwa.insurance/ords/r/sl_ws/slportal10511020151201212044/document?p3_token=${secureToken}`;
          reply = `برجاء رفع المستندات المطلوبة (الكارنية الطبي، الروشتة، الفحوصات) عبر الرابط التالي:\n${uploadUrl}`;
        } else if (rawBody === "3") {
          reply = "للاستفسارات برجاء الاتصال علي XXXX";
        }

        await sendUltraReply(from, reply);
        await logMessage({ member_id: memberId, message: reply, sender: "BOT", user_number: cleanFrom });
      } else {
        // لو الإدخال مش 1, 2, أو 3
        const reply = "عذراً، لم أفهم طلبكم. برجاء اختيار أحد الخيارات المتاحة أو التواصل على رقم XXXX";
        await sendUltraReply(from, reply);
        await logMessage({ member_id: verifiedUsers.get(from).memberId, message: reply, sender: "BOT", user_number: cleanFrom });
      }
      return res.sendStatus(200);
    }

    // 4. لو دي أول رسالة من المستخدم
    if (!welcomedUsers.has(from)) {
      const reply = "مرحباً بكم في ثروة لتأمينات الحياة!\nبرجاء إدخال رقم الكارت الطبي الخاص بكم للمتابعة.";
      await sendUltraReply(from, reply);
      await logMessage({ member_id: null, message: reply, sender: "BOT", user_number: cleanFrom });
      welcomedUsers.add(from); // إضافة المستخدم للترحيب
      return res.sendStatus(200);
    }

    // 5. التحقق من إن الإدخال أرقام فقط
    const memberId = rawBody.replace(/\D/g, "");
    if (!memberId || !/^\d+$/.test(rawBody)) {
      const reply = "برجاء إدخال رقم الكارت الطبي الصحيح أو التواصل على XXXX أو إرسال طلبكم عبر البريد Chronic@Sarwa.life";
      await sendUltraReply(from, reply);
      await logMessage({ member_id: null, message: reply, sender: "BOT", user_number: cleanFrom });
      return res.sendStatus(200);
    }

    // 6. استدعاء Sarwa ORDS API
    const ordsUrl = `${SARWA_API_BASE}/${encodeURIComponent(memberId)}`;
    console.log("🔍 Calling Sarwa ORDS:", ordsUrl);

    let sarwaJson = null;
    try {
      const r = await fetch(ordsUrl, { method: "GET" });
      sarwaJson = await r.json();
      console.log("🔎 Sarwa response (count):", sarwaJson.count || (sarwaJson.items && sarwaJson.items.length));
    } catch (err) {
      console.error("❌ Error calling Sarwa API:", err && err.message ? err.message : err);
      const reply = "حصل خطأ أثناء التحقق من النظام، برجاء المحاولة لاحقًا.";
      await sendUltraReply(from, reply);
      await logMessage({ member_id: null, message: reply, sender: "BOT", user_number: cleanFrom });
      return res.sendStatus(200);
    }

    // 7. بناء الرد
    let reply = "برجاء إدخال رقم الكارت الطبي الصحيح أو التواصل على XXXX أو إرسال طلبكم عبر البريد Chronic@Sarwa.life";
    let detectedMemberId = null;
    if (sarwaJson && Array.isArray(sarwaJson.items) && sarwaJson.items.length > 0) {
      const member = sarwaJson.items[0];
      const name = member.member_name || member.MEMBER_NAME || "العميل";
      detectedMemberId = member.member_id || member.MEMBER_ID || null;

      reply = `أهلاً ${name}، كيف يمكننا مساعدتك اليوم؟\n1 - لإضافة علاج شهري جديد\n2 - لتعديل علاج شهري\n3 - للاستفسارات`;

      // نخزن الـ memberId والاسم + userNumber
      verifiedUsers.set(from, { memberId: detectedMemberId, name: name, userNumber: cleanFrom });
    }

    // 8. أرسل الرد عبر Ultramsg
    const sendResult = await sendUltraReply(from, reply);
    console.log("📤 Ultramsg send result:", JSON.stringify(sendResult).slice(0, 1000));

    // 9. سجل رد البوت
    await logMessage({
      member_id: detectedMemberId,
      message: reply,
      sender: "BOT",
      user_number: cleanFrom
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook handler unexpected error:", err);
    return res.sendStatus(200);
  }
});

// دالة لتخزين الرسائل في جدول SL_MEMBER_LOG_CHAT_BOT_MASTER عبر ORDS API
async function logMessage({ member_id, message, sender, user_number }) {
  try {
    const memberIdVal = (member_id === null || member_id === undefined || member_id === "") ? null : Number(member_id);
    const cleanUserNumber = user_number.split('@')[0]; // إزالة @c.us

    const body = {
      member_id: memberIdVal,
      message: message || null,
      sender: sender || null,
      user_number: cleanUserNumber
    };

    console.log("🟢 logMessage -> sending to ORDS:", JSON.stringify(body));

    const resp = await fetch(SARWA_LOG_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const json = await resp.json(); // توقع JSON response
    console.log("📝 ORDS response status:", resp.status);
    console.log("📝 ORDS response body:", JSON.stringify(json));

    if (!resp.ok) {
      console.error("❌ ORDS returned non-OK for logMessage:", resp.status, JSON.stringify(json));
    } else if (json.status && json.status.includes('ERROR')) {
      console.error("❌ ORDS returned error status:", json.status);
    } else {
      console.log("✅ Message logged successfully:", json.status);
    }

    return { status: resp.status, body: json };
  } catch (err) {
    console.error("❌ logMessage error:", err && err.message ? err.message : err);
    return { error: err ? err.message : "unknown" };
  }
}

// دالة مساعدة لإرسال رسالة عبر Ultramsg
async function sendUltraReply(to, text) {
  try {
    const params = new URLSearchParams();
    params.append("token", ULTRA_TOKEN);
    params.append("to", to);
    params.append("body", text);

    const resp = await fetch(ULTRA_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });

    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const json = await resp.json();
      return { status: resp.status, body: json };
    } else {
      const textBody = await resp.text();
      return { status: resp.status, body: textBody };
    }
  } catch (err) {
    console.error("❌ sendUltraReply error:", err);
    return { error: err.toString() };
  }
}

// دالة لإنشاء توكن آمن
function createSecureToken(memberId, userNumber) {
  const cleanUserNumber = userNumber.split('@')[0]; // إزالة @c.us
  const timestamp = Date.now();
  const data = `${memberId}:${cleanUserNumber}:${timestamp}`;
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(data);
  const signature = hmac.digest('hex');
  const tokenData = `${data}:${signature}`;
  return Buffer.from(tokenData).toString('base64');
}

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
