import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";

import { prisma } from "@/lib/prisma";

const googleProvider =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? Google({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        authorization: {
          params: {
            scope: "openid email profile"
          }
        }
      })
    : null;

export const authConfig = {
  adapter: PrismaAdapter(prisma),
  providers: googleProvider ? [googleProvider] : [],
  session: {
    strategy: "database"
  },
  callbacks: {
    signIn({ profile }) {
      const allowedEmails = (process.env.AUTH_ALLOWED_EMAILS ?? "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean);

      if (!allowedEmails.length) {
        return true;
      }

      const email = profile?.email?.toLowerCase();

      return Boolean(email && allowedEmails.includes(email));
    },
    session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }

      return session;
    }
  }
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
