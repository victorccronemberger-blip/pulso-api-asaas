import nodemailer from "nodemailer";

const escapeHtml = (value) => String(value).replace(
  /[&<>"']/g,
  (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character],
);

function messageTemplate({ displayName, actionLabel, actionUrl, introduction }) {
  const safeName = escapeHtml(displayName);
  const safeUrl = escapeHtml(actionUrl);
  return `<!doctype html>
<html lang="pt-BR"><body style="margin:0;background:#f6f7fb;font-family:Arial,sans-serif;color:#00043A">
  <div style="max-width:600px;margin:0 auto;padding:40px 20px">
    <div style="background:#fff;border-radius:20px;overflow:hidden;border:1px solid #e7e9f1">
      <div style="padding:24px 30px;background:#00043A;color:#fff;font-size:22px;font-weight:800">PULSO BANCÁRIO</div>
      <div style="padding:32px 30px">
        <h1 style="font-size:24px;margin:0 0 16px">Olá, ${safeName}.</h1>
        <p style="font-size:16px;line-height:1.6;margin:0 0 26px">${introduction}</p>
        <a href="${safeUrl}" style="display:inline-block;padding:15px 22px;background:#C00021;color:#fff;text-decoration:none;border-radius:12px;font-weight:700">${actionLabel}</a>
        <p style="font-size:13px;line-height:1.5;color:#5d6475;margin:28px 0 0">Se você não solicitou esta ação, ignore esta mensagem. O link é pessoal, expira automaticamente e só pode ser usado uma vez.</p>
      </div>
    </div>
  </div>
</body></html>`;
}

export function createCustomerMailer(environment) {
  if (!environment.emailAvailable) {
    return Object.freeze({
      available: false,
      async sendEmailVerification() {
        throw new Error("Transactional email is not configured.");
      },
      async sendPasswordReset() {
        throw new Error("Transactional email is not configured.");
      },
    });
  }

  const transporter = nodemailer.createTransport({
    host: environment.smtpHost,
    port: environment.smtpPort,
    secure: environment.smtpSecure,
    auth: {
      user: environment.smtpUser,
      pass: environment.smtpPassword,
    },
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const from = `PULSO Bancário <${environment.emailFrom}>`;

  return Object.freeze({
    available: true,
    async sendEmailVerification({ customer, token }) {
      const actionUrl = `${environment.publicOrigin}/conta/verificar-email/?token=${encodeURIComponent(token)}`;
      await transporter.sendMail({
        from,
        to: customer.email,
        subject: "Confirme seu e-mail no PULSO Bancário",
        text: `Confirme seu e-mail: ${actionUrl}`,
        html: messageTemplate({
          displayName: customer.displayName,
          actionLabel: "Confirmar meu e-mail",
          actionUrl,
          introduction: "Confirme seu endereço de e-mail para proteger sua conta e seus pedidos.",
        }),
      });
    },
    async sendPasswordReset({ customer, token }) {
      const actionUrl = `${environment.publicOrigin}/conta/redefinir-senha/?token=${encodeURIComponent(token)}`;
      await transporter.sendMail({
        from,
        to: customer.email,
        subject: "Redefina sua senha do PULSO Bancário",
        text: `Redefina sua senha: ${actionUrl}`,
        html: messageTemplate({
          displayName: customer.displayName,
          actionLabel: "Criar nova senha",
          actionUrl,
          introduction: "Recebemos uma solicitação para redefinir a senha da sua conta.",
        }),
      });
    },
  });
}
