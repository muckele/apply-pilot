import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";

import { isEmailAllowedForAuth } from "@/lib/auth-access";
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
      return isEmailAllowedForAuth(profile?.email);
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
