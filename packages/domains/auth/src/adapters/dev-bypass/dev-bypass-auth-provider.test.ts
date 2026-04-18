import { Email } from "@x1agent/kernel";
import { runAuthProviderContract } from "../../contract-tests/auth-provider.contract.js";
import { DevBypassAuthProvider } from "./dev-bypass-auth-provider.js";

runAuthProviderContract({
  name: "DevBypassAuthProvider",
  factory: () =>
    new DevBypassAuthProvider({
      email: "alice@example.com",
      name: "Alice",
    }),
  validExchange: {
    code: "bypass",
    expected: {
      email: Email("alice@example.com"),
      name: "Alice",
      avatarUrl: null,
      providerUserId: "dev-bypass::alice@example.com",
      providerId: "dev-bypass",
    },
  },
  invalidCode: "nope",
});
