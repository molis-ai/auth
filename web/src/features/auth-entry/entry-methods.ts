type Operation = { purpose?: string; identityType?: string };

export const operationMethods = (props: Operation) =>
  props.identityType
    ? [
        [
          props.identityType === "EMAIL"
            ? "EMAIL_CODE"
            : props.identityType === "PHONE"
              ? "PHONE_OTP"
              : props.identityType,
          props.identityType,
        ],
      ]
    : props.purpose === "EMAIL_SIGNUP" || props.purpose === "PASSWORD_RESET"
      ? [["EMAIL_CODE", "邮箱验证码"]]
      : props.purpose === "BIND" || props.purpose === "REPLACE"
        ? [
            ["EMAIL_CODE", "邮箱验证码"],
            ["PHONE_OTP", "手机验证码"],
            ["GOOGLE", "Google"],
            ["GITHUB", "GitHub"],
          ]
        : [
            ["EMAIL_PASSWORD", "邮箱密码"],
            ["PHONE_OTP", "手机验证码"],
            ["GOOGLE", "Google"],
            ["GITHUB", "GitHub"],
          ];

export function initialOperationMethod({ purpose, identityType }: Operation): string | undefined {
  if (purpose !== "EMAIL_SIGNUP" && purpose !== "PASSWORD_RESET" &&
      purpose !== "BIND" && purpose !== "REPLACE") return undefined;
  if (identityType === "PHONE") return "PHONE_OTP";
  return identityType && identityType !== "EMAIL" ? identityType : "EMAIL_CODE";
}
