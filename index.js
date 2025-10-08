import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";

const app = express();
app.use(bodyParser.json());

// --- إعداد القيم الأساسية --- //
const ULTRA_INSTANCE_ID = "instance142984";
const ULTRA_TOKEN = "799w3nqqj4fbwxt9";
const ULTRA_SEND_URL = `https://api.ultramsg.com/${ULTRA_INSTANCE_ID}/messages/chat`;

const SARWA_API_BASE = "https://sl-portal.sarwa.insurance/ords/sl_ws/MEMBERS";
const SARWA_LOG_API = "https://sl-portal.sarwa.insurance/ords/sl_ws/discussion/messages"; 
const SECRET_KEY = "your_super_secret_key_here_change_this"; 
// ------------------------------ //

// ذاكرة مؤقتة
const processedMessages = new Set();
const welcomedUsers = new Set();
const verifiedUsers = new Map();

// Endpoint للتجربة
app.get("/", (req, res) => res.send("✅ Server is running on Vercel"));

// Webhook الرئيسي
app.post("/", async (req, res) => {
  try {
    const data = req.body.data || req.body;
    const from = data.from;
    const cleanFrom = from.split("@")[0];
    const rawBody = (data.body || "").toString().trim();
    const messageHash = req.body.hash;

    console.log("👤 From:", from);
    console.log("💬 Body:", rawBody);

    // تجاهل الرسائل المكررة
    if (processedMessages.has(messageHash)) return res.sendStatus(200);
    processedMessages.add(messageHash);

    // سجل الرسالة الواردة
    await logMessage({
      member_id: null,
      message: rawBody,
      sender: "USER",
      user_number: cleanFrom
    });

    // لو المستخدم معروف
    if (verifiedUsers.has(from)) {
      if (["1", "2", "3"].includes(rawBody)) {
        const { memberId, userNumber } = verifiedUsers.get(from);
        const cleanUserNumber = userNumber.split("@")[0];
        let reply = "";

        if (rawBody === "1" || rawBody === "2") {
          const secureToken = createSecureToken(memberId, cleanUserNumber);
          const uploadUrl = `https://sl-portal.sarwa.insurance/ords/r/sl_ws/slportal10511020151201212044/document?p3_token=${secureToken}`;
          reply = `برجاء رفع المستندات المطلوبة (الكارنية الطبي، الروشتة، الفحوصات) عبر الرابط التالي:\n${uploadUrl}`;
        } else {
          reply = "للاستفسارات برجاء الاتصال علي XXXX";
        }

        await sendUltraReply(from, reply);
        await logMessage({ member_id: memberId, message: reply, sender: "BOT", user_number: cleanFrom });
        return res.sendStatus(200);
      }

      const reply = "عذراً، لم أفهم طلبكم. برجاء اختيار أحد الخيارات المتاحة.";
      await sendUltraReply(from, reply);
      await logMessage({ member_id: verifiedUsers.get(from).memberId, message: reply, sender: "BOT", user_number: cleanFrom });
      return res.sendStatus(200);
    }

    // أول مرة
    if (!welcomedUsers.has(from)) {
      const reply = "مرحباً بكم في ثروة لتأمينات الحياة!\nبرجاء إدخال رقم الكارت الطبي الخاص بكم للمتابعة.";
      await sendUltraReply(from, reply);
      await logMessage({ member_id: null, message: reply, sender: "BOT", user_number: cleanFrom });
      welcomedUsers.add(from);
      return res.sendStatus(200);
    }

    // تحقق من الرقم
    const memberId = rawBody.replace(/\D/g, "");
    if (!memberId || !/^\d+$/.test(rawBody)) {
      const reply = "برجاء إدخال رقم الكارت الطبي الصحيح أو التواصل على XXXX.";
      await sendUltraReply(from, reply);
      await logMessage({ member_id: null, message: reply, sender: "BOT", user_number: cleanFrom });
      return res.sendStatus(200);
    }

    // تحقق من ORDS
    const ordsUrl = `${SARWA_API_BASE}/${encodeURIComponent(memberId)}`;
    console.log("🔍 Calling Sarwa ORDS:", ordsUrl);

    const r = await fetch(ordsUrl);
    const sarwaJson = await r.json();

    let reply = "برجاء إدخال رقم الكارت الطبي الصحيح.";
    let detectedMemberId = null;

    if (sarwaJson?.items?.length > 0) {
      const member = sarwaJson.items[0];
      const name = member.member_name || member.MEMBER_NAME || "العميل";
      detectedMemberId = member.member_id || member.MEMBER_ID;

      reply = `أهلاً ${name}، كيف يمكننا مساعدتك اليوم؟\n1 - لإضافة علاج شهري جديد\n2 - لتعديل علاج شهري\n3 - للاستفسارات`;

      verifiedUsers.set(from, { memberId: detectedMemberId, name, userNumber: cleanFrom });
    }

    await sendUltraReply(from, reply);
    await logMessage({ member_id: detectedMemberId, message: reply, sender: "BOT", user_number: cleanFrom });
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook Error:", err);
    res.sendStatus(200);
  }
});

// دالة تسجيل الرسائل
async function logMessage({ member_id, message, sender, user_number }) {
  try {
    const cleanUser = user_number.split("@")[0];
    const body = { member_id, message, sender, user_number: cleanUser };
    const resp = await fetch(SARWA_LOG_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    console.log("🟢 logMessage Status:", resp.status);
  } catch (err) {
    console.error("❌ logMessage error:", err.message);
  }
}

// إرسال رسالة
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
    console.log("📤 Sent to:", to);
  } catch (err) {
    console.error("❌ sendUltraReply error:", err.message);
  }
}

// إنشاء توكن
function createSecureToken(memberId, userNumber) {
  const timestamp = Date.now();
  const data = `${memberId}:${userNumber}:${timestamp}`;
  const hmac = crypto.createHmac("sha256", SECRET_KEY);
  hmac.update(data);
  const signature = hmac.digest("hex");
  return Buffer.from(`${data}:${signature}`).toString("base64");
}

export default app;
