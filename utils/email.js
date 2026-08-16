const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
  connectionTimeout: 10000, // 10 seconds
  greetingTimeout: 10000,
  socketTimeout: 10000,
});

const sendVerificationEmail = async (email, name, token) => {
  const verificationUrl = `${process.env.CLIENT_URL}/verify-email/${token}`;

  await transporter.sendMail({
    from: `"EduConnect" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Verify Your Email - EduConnect',
    html: `
      <div style="max-width: 600px; margin: auto; padding: 20px; font-family: 'Inter', Arial, sans-serif; background-color: #F0F4FF; border-radius: 12px;">
        <div style="text-align: center; padding: 20px;">
          <h1 style="color: #4F46E5; font-family: 'Poppins', sans-serif;">EduConnect</h1>
          <p style="color: #1E293B; font-size: 16px;">Where Academic Careers Begin</p>
        </div>
        <div style="background: white; padding: 30px; border-radius: 8px; text-align: center;">
          <h2 style="color: #1E293B;">Welcome, ${name}! 🎓</h2>
          <p style="color: #475569; font-size: 15px; line-height: 1.6;">
            Thank you for joining EduConnect. Please verify your email address to get started.
          </p>
          <a href="${verificationUrl}" 
             style="display: inline-block; margin: 20px 0; padding: 14px 36px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
            Verify Email
          </a>
          <p style="color: #94A3B8; font-size: 12px; margin-top: 20px;">
            This link expires in 1 hour. If you didn't create an account, please ignore this email.
          </p>
        </div>
      </div>
    `,
  });
};

const sendPasswordResetOTP = async (email, otp) => {
  await transporter.sendMail({
    from: `"EduConnect" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Password Reset OTP - EduConnect',
    html: `
      <div style="max-width: 600px; margin: auto; padding: 20px; font-family: 'Inter', Arial, sans-serif; background-color: #F0F4FF; border-radius: 12px;">
        <div style="text-align: center; padding: 20px;">
          <h1 style="color: #4F46E5; font-family: 'Poppins', sans-serif;">EduConnect</h1>
        </div>
        <div style="background: white; padding: 30px; border-radius: 8px; text-align: center;">
          <h2 style="color: #1E293B;">Reset Your Password</h2>
          <p style="color: #475569; font-size: 15px; line-height: 1.6;">
            Use the following OTP to reset your password:
          </p>
          <div style="margin: 20px 0; padding: 15px; background-color: #EEF2FF; border-radius: 8px;">
            <span style="font-size: 32px; font-weight: 700; color: #4F46E5; letter-spacing: 8px;">${otp}</span>
          </div>
          <p style="color: #94A3B8; font-size: 12px; margin-top: 20px;">
            This OTP expires in 15 minutes. If you didn't request this, please ignore this email.
          </p>
        </div>
      </div>
    `,
  });
};

const sendRegistrationOTP = async (email, name, otp) => {
  await transporter.sendMail({
    from: `"EduConnect" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Your EduConnect Verification Code',
    html: `
      <div style="max-width: 600px; margin: auto; padding: 20px; font-family: 'Inter', Arial, sans-serif; background-color: #F0F4FF; border-radius: 12px;">
        <div style="text-align: center; padding: 20px;">
          <h1 style="color: #4F46E5; font-family: 'Poppins', sans-serif;">EduConnect</h1>
        </div>
        <div style="background: white; padding: 30px; border-radius: 8px; text-align: center;">
          <h2 style="color: #1E293B;">Welcome, ${name}!</h2>
          <p style="color: #475569; font-size: 15px; line-height: 1.6;">
            Use this code to verify your email and activate your account:
          </p>
          <div style="margin: 20px 0; padding: 15px; background-color: #EEF2FF; border-radius: 8px;">
            <span style="font-size: 32px; font-weight: 700; color: #4F46E5; letter-spacing: 8px;">  ${otp}</span>
          </div>
          <p style="color: #94A3B8; font-size: 12px; margin-top: 20px;">
            This code expires in 10 minutes. If you didn't create an account, please ignore this email.
          </p>
        </div>
      </div>
    `,
  });
};

module.exports = { sendVerificationEmail, sendPasswordResetOTP, sendRegistrationOTP };
