import nodemailer from "nodemailer";

export async function sendVerificationEmail(email: string, code: string) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || "DailyReport ERP <no-reply@dailyreport.local>";

  if (!host || !user || !pass) {
    console.log(`[email verification] ${email}: ${code}`);
    return { delivered: false, devCode: code };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });

  try {
    await transporter.sendMail({
      from,
      to: email,
      subject: "Код подтверждения DailyReport ERP",
      text: `Ваш код подтверждения: ${code}. Код действует 15 минут.`,
      html: `<p>Ваш код подтверждения: <strong>${code}</strong></p><p>Код действует 15 минут.</p>`
    });

    return { delivered: true, devCode: code };
  } catch (error) {
    console.error("Ошибка при отправке почты (SMTP):", error);
    return { delivered: false, devCode: code };
  }
}
