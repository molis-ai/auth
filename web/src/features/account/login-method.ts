export interface LoginMethod {
  bindingId: string;
  type: string;
  maskedLabel: string;
  verified: boolean;
  usableForLogin: boolean;
}
