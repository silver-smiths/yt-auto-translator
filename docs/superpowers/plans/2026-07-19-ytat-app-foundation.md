# YTAT 앱 — Plan 1: 기반 + 인증 + 계정 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** RN+Expo 앱이 구글 로그인 후 백엔드에서 크레딧 잔액을 불러와 홈 화면에 표시한다 (동작하는 최소 인증 앱).

**Architecture:** Expo(React Native) 클라이언트가 expo-auth-session으로 Google OAuth 액세스 토큰(scope: youtube.force-ssl 포함)을 얻어 SecureStore에 저장하고, 기존 Cloudflare 백엔드에 `Authorization: Bearer <accessToken>`로 요청한다. 백엔드·API 계약은 익스텐션과 100% 동일(무변경).

**Tech Stack:** Expo SDK(최신 안정), TypeScript, expo-auth-session, expo-secure-store, expo-crypto(PKCE), Jest + ts-jest.

## Global Constraints
- API_BASE = `https://yt-auto-translator-api.1009yjh.workers.dev` (백엔드 무변경 재사용)
- 인증: Google OAuth **액세스 토큰**을 `Authorization: Bearer`로 전송. 401 시 갱신 후 1회 재시도.
- OAuth scopes: `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/youtube.force-ssl`
- GCP 프로젝트: 1055946215440 (기존). **모바일용 OAuth 클라이언트 ID(iOS/Android)를 신규 발급**해야 함 — 익스텐션 client_id(Chrome 앱 타입)는 재사용 불가.
- 프로젝트 위치: `/Users/jeongheeyoon/Desktop/developer/web/ytat-app/` (신규 Expo 프로젝트, 익스텐션·백엔드와 형제)
- 번들 ID: `com.silversmith.ytat` (앱 표시명은 미정이나 번들 ID는 고정)
- 언어/카피: 사용자 대면 문구는 한국어 기본 (i18n은 Plan 4에서 도입, 이 플랜은 한국어 하드코딩 허용)
- 커밋: 각 태스크 끝에서 커밋. 커밋 메시지 conventional commits.

---

## File Structure (이 플랜에서 생성/수정)
- `ytat-app/app.config.ts` — Expo 설정(번들 ID, scheme, OAuth redirect)
- `ytat-app/src/lib/constants.ts` — API_BASE, OAUTH(clientId/scopes), 색상 등 상수
- `ytat-app/src/lib/secure-store.ts` — 토큰 영속화 래퍼 (테스트 대상)
- `ytat-app/src/lib/api.ts` — authFetch(Bearer + 401 재시도), fetchCredits (테스트 대상)
- `ytat-app/src/lib/auth.ts` — Google OAuth(PKCE code 교환) + 토큰 갱신
- `ytat-app/src/context/AuthContext.tsx` — 인증 상태 provider
- `ytat-app/src/screens/SignInScreen.tsx` — 로그아웃 상태 화면
- `ytat-app/src/screens/HomeScreen.tsx` — 로그인 상태 화면(이메일·잔액)
- `ytat-app/App.tsx` — 루트, 인증 게이팅
- `ytat-app/src/lib/__tests__/*.test.ts` — 유닛 테스트

---

### Task 1: Expo 프로젝트 스캐폴드 + 설정

**Files:**
- Create: `ytat-app/` (Expo TS 템플릿 전체)
- Create: `ytat-app/app.config.ts`
- Create: `ytat-app/jest.config.js`

**Interfaces:**
- Produces: 실행 가능한 빈 Expo 앱, `npm test` 동작 환경.

- [ ] **Step 1: Expo 앱 생성**

```bash
cd /Users/jeongheeyoon/Desktop/developer/web
npx create-expo-app@latest ytat-app --template blank-typescript
cd ytat-app
npx expo install expo-auth-session expo-crypto expo-secure-store expo-web-browser
npm install --save-dev jest ts-jest @types/jest
```

- [ ] **Step 2: `app.config.ts` 작성 (번들 ID·scheme)**

```ts
import { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'YTAT',                    // 표시명은 추후 확정
  slug: 'ytat-app',
  scheme: 'ytat',                  // OAuth redirect용 커스텀 스킴
  version: '0.1.0',
  orientation: 'portrait',
  ios: { bundleIdentifier: 'com.silversmith.ytat', supportsTablet: true },
  android: { package: 'com.silversmith.ytat' },
  plugins: ['expo-secure-store'],
};
export default config;
```

- [ ] **Step 3: `jest.config.js` 작성**

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
};
```

- [ ] **Step 4: 스모크 확인**

Run: `npx tsc --noEmit && npm test -- --passWithNoTests`
Expected: 타입 에러 없음, Jest "No tests found"이지만 통과(exit 0).

- [ ] **Step 5: Commit**

```bash
cd /Users/jeongheeyoon/Desktop/developer/web/ytat-app
git init && git add -A
git commit -m "chore(app): scaffold Expo TS project + jest"
```

---

### Task 2: 상수 모듈 (`constants.ts`)

**Files:**
- Create: `ytat-app/src/lib/constants.ts`
- Test: `ytat-app/src/lib/__tests__/constants.test.ts`

**Interfaces:**
- Produces: `API_BASE: string`, `OAUTH_SCOPES: string[]`, `OAUTH: { iosClientId: string; androidClientId: string }`

- [ ] **Step 1: 실패 테스트 작성**

```ts
// src/lib/__tests__/constants.test.ts
import { API_BASE, OAUTH_SCOPES } from '../constants';

test('API_BASE는 워커 도메인', () => {
  expect(API_BASE).toBe('https://yt-auto-translator-api.1009yjh.workers.dev');
});
test('scope에 youtube.force-ssl 포함', () => {
  expect(OAUTH_SCOPES).toContain('https://www.googleapis.com/auth/youtube.force-ssl');
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npm test -- constants`
Expected: FAIL — "Cannot find module '../constants'"

- [ ] **Step 3: 구현**

```ts
// src/lib/constants.ts
export const API_BASE = 'https://yt-auto-translator-api.1009yjh.workers.dev';

export const OAUTH_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

// 신규 발급한 모바일 OAuth 클라이언트 ID를 넣는다 (GCP 프로젝트 1055946215440)
export const OAUTH = {
  iosClientId: 'REPLACE_WITH_IOS_CLIENT_ID.apps.googleusercontent.com',
  androidClientId: 'REPLACE_WITH_ANDROID_CLIENT_ID.apps.googleusercontent.com',
};
```
> 주: iosClientId/androidClientId는 이사님이 GCP 콘솔에서 발급한 실제 값으로 교체. 이 두 값은 코드가 아니라 설정값이며, 발급 전까지 앱 OAuth는 동작하지 않는다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test -- constants`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/constants.ts src/lib/__tests__/constants.test.ts
git commit -m "feat(app): add constants (API_BASE, OAuth scopes)"
```

---

### Task 3: 토큰 보안 저장 (`secure-store.ts`)

**Files:**
- Create: `ytat-app/src/lib/secure-store.ts`
- Test: `ytat-app/src/lib/__tests__/secure-store.test.ts`

**Interfaces:**
- Produces: `saveTokens(t: TokenSet): Promise<void>`, `loadTokens(): Promise<TokenSet | null>`, `clearTokens(): Promise<void>`
- `TokenSet = { accessToken: string; refreshToken: string | null; expiresAt: number }`

- [ ] **Step 1: 실패 테스트 작성 (expo-secure-store 모킹)**

```ts
// src/lib/__tests__/secure-store.test.ts
jest.mock('expo-secure-store', () => {
  const store: Record<string, string> = {};
  return {
    setItemAsync: jest.fn(async (k: string, v: string) => { store[k] = v; }),
    getItemAsync: jest.fn(async (k: string) => store[k] ?? null),
    deleteItemAsync: jest.fn(async (k: string) => { delete store[k]; }),
  };
});
import { saveTokens, loadTokens, clearTokens } from '../secure-store';

test('save→load 왕복', async () => {
  await saveTokens({ accessToken: 'a', refreshToken: 'r', expiresAt: 123 });
  expect(await loadTokens()).toEqual({ accessToken: 'a', refreshToken: 'r', expiresAt: 123 });
});
test('clear 후 null', async () => {
  await saveTokens({ accessToken: 'a', refreshToken: null, expiresAt: 1 });
  await clearTokens();
  expect(await loadTokens()).toBeNull();
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- secure-store`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```ts
// src/lib/secure-store.ts
import * as SecureStore from 'expo-secure-store';

export type TokenSet = { accessToken: string; refreshToken: string | null; expiresAt: number };
const KEY = 'ytat_tokens';

export async function saveTokens(t: TokenSet): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(t));
}
export async function loadTokens(): Promise<TokenSet | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  return raw ? (JSON.parse(raw) as TokenSet) : null;
}
export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- secure-store`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/secure-store.ts src/lib/__tests__/secure-store.test.ts
git commit -m "feat(app): secure token storage wrapper"
```

---

### Task 4: API 클라이언트 (`api.ts`) — Bearer + 401 재시도

**Files:**
- Create: `ytat-app/src/lib/api.ts`
- Test: `ytat-app/src/lib/__tests__/api.test.ts`

**Interfaces:**
- Consumes: `getValidAccessToken(): Promise<string>` (Task 5 제공 — 이 태스크에서는 주입받는 형태로 설계해 테스트 가능하게 함)
- Produces: `makeApi(getToken: () => Promise<string>) => { fetchCredits(): Promise<{ balance: number; tier: number; multiplier: number }> }`

- [ ] **Step 1: 실패 테스트 작성 (fetch 모킹, 401 재시도 검증)**

```ts
// src/lib/__tests__/api.test.ts
import { makeApi } from '../api';

function mockFetchSequence(responses: { status: number; body?: any }[]) {
  let i = 0;
  return jest.fn(async () => {
    const r = responses[i++] ?? responses[responses.length - 1];
    return { ok: r.status >= 200 && r.status < 300, status: r.status,
             json: async () => r.body ?? {} } as any;
  });
}

test('정상 잔액 조회', async () => {
  (global as any).fetch = mockFetchSequence([{ status: 200, body: { balance: 1000, tier: 1, multiplier: 20 } }]);
  const api = makeApi(async () => 'tok');
  expect(await api.fetchCredits()).toEqual({ balance: 1000, tier: 1, multiplier: 20 });
});

test('401이면 토큰 갱신 후 1회 재시도', async () => {
  (global as any).fetch = mockFetchSequence([{ status: 401 }, { status: 200, body: { balance: 5, tier: 1, multiplier: 20 } }]);
  const getToken = jest.fn().mockResolvedValueOnce('old').mockResolvedValueOnce('new');
  const api = makeApi(getToken);
  const res = await api.fetchCredits();
  expect(res.balance).toBe(5);
  expect(getToken).toHaveBeenCalledTimes(2);   // 최초 + 갱신
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- api`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```ts
// src/lib/api.ts
import { API_BASE } from './constants';

async function authFetch(getToken: () => Promise<string>, path: string, options: RequestInit = {}) {
  let token = await getToken();
  const doFetch = (t: string) => fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  let res = await doFetch(token);
  if (res.status === 401) {
    token = await getToken();          // 만료 → 갱신 토큰으로 재발급 (Task 5)
    res = await doFetch(token);
  }
  return res;
}

export function makeApi(getToken: () => Promise<string>) {
  return {
    async fetchCredits() {
      const res = await authFetch(getToken, '/credits');
      if (!res.ok) throw new Error(`CREDITS_FETCH_FAILED_${res.status}`);
      return res.json() as Promise<{ balance: number; tier: number; multiplier: number }>;
    },
  };
}
```
> 주: 401 재시도 시 `getToken`이 "만료면 갱신"을 담당(Task 5의 getValidAccessToken). 여기선 주입만 받는다.

- [ ] **Step 4: 통과 확인**

Run: `npm test -- api`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/__tests__/api.test.ts
git commit -m "feat(app): API client with Bearer auth + 401 retry"
```

---

### Task 5: Google OAuth + 토큰 갱신 (`auth.ts`)

**Files:**
- Create: `ytat-app/src/lib/auth.ts`
- Test: `ytat-app/src/lib/__tests__/auth.test.ts` (갱신 판단 로직만 유닛 테스트; 핸드셰이크는 수동 E2E)

**Interfaces:**
- Consumes: `constants.OAUTH`, `secure-store` 함수들
- Produces:
  - `useGoogleSignIn(): { promptAsync, request }` (expo-auth-session 훅 래핑)
  - `exchangeCodeForTokens(code, codeVerifier, redirectUri): Promise<TokenSet>`
  - `getValidAccessToken(): Promise<string>` — 만료(<60s)면 refreshToken으로 갱신 후 저장
  - `isExpired(expiresAt: number, now: number): boolean` (순수 함수, 테스트 대상)

- [ ] **Step 1: 순수 함수 실패 테스트**

```ts
// src/lib/__tests__/auth.test.ts
import { isExpired } from '../auth';
test('만료 60초 이내면 true', () => {
  expect(isExpired(1_000_000, 1_000_000 - 30_000)).toBe(true);   // 30s 남음 → 갱신
  expect(isExpired(1_000_000, 1_000_000 - 120_000)).toBe(false); // 120s 남음
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- auth`
Expected: FAIL — isExpired 없음

- [ ] **Step 3: 구현 (`auth.ts`)**

```ts
// src/lib/auth.ts
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { OAUTH, OAUTH_SCOPES } from './constants';
import { saveTokens, loadTokens, type TokenSet } from './secure-store';

WebBrowser.maybeCompleteAuthSession();

const DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
};
const REDIRECT_URI = AuthSession.makeRedirectUri({ scheme: 'ytat' });
const CLIENT_ID = Platform.OS === 'ios' ? OAUTH.iosClientId : OAUTH.androidClientId;

// 순수 함수 — 만료 60초 이내면 갱신 필요
export function isExpired(expiresAt: number, now: number): boolean {
  return expiresAt - now < 60_000;
}

// 로그인 훅 (화면에서 사용): PKCE code 흐름
export function useGoogleSignIn() {
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: CLIENT_ID,
      scopes: OAUTH_SCOPES,
      redirectUri: REDIRECT_URI,
      responseType: AuthSession.ResponseType.Code,
      usePKCE: true,
      extraParams: { access_type: 'offline', prompt: 'consent' }, // refresh token 수신
    },
    DISCOVERY,
  );
  return { request, response, promptAsync };
}

// code → 토큰 교환 (설치형 앱: client secret 없이 PKCE)
export async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<TokenSet> {
  const res = await AuthSession.exchangeCodeAsync(
    { clientId: CLIENT_ID, code, redirectUri: REDIRECT_URI, extraParams: { code_verifier: codeVerifier } },
    DISCOVERY,
  );
  const tokens: TokenSet = {
    accessToken: res.accessToken,
    refreshToken: res.refreshToken ?? null,
    expiresAt: Date.now() + (res.expiresIn ?? 3600) * 1000,
  };
  await saveTokens(tokens);
  return tokens;
}

// 유효한 액세스 토큰 반환 — 만료 임박이면 refresh
export async function getValidAccessToken(): Promise<string> {
  const t = await loadTokens();
  if (!t) throw new Error('NOT_SIGNED_IN');
  if (!isExpired(t.expiresAt, Date.now())) return t.accessToken;
  if (!t.refreshToken) throw new Error('NOT_SIGNED_IN'); // 재로그인 필요
  const refreshed = await AuthSession.refreshAsync(
    { clientId: CLIENT_ID, refreshToken: t.refreshToken },
    DISCOVERY,
  );
  const next: TokenSet = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? t.refreshToken,
    expiresAt: Date.now() + (refreshed.expiresIn ?? 3600) * 1000,
  };
  await saveTokens(next);
  return next.accessToken;
}
```

- [ ] **Step 4: 순수 함수 통과 확인**

Run: `npm test -- auth`
Expected: PASS (isExpired)

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth.ts src/lib/__tests__/auth.test.ts
git commit -m "feat(app): Google OAuth (PKCE) + token refresh"
```

---

### Task 6: 인증 컨텍스트 + 게이트 화면 (수동 E2E)

**Files:**
- Create: `ytat-app/src/context/AuthContext.tsx`
- Create: `ytat-app/src/screens/SignInScreen.tsx`
- Create: `ytat-app/src/screens/HomeScreen.tsx`
- Modify: `ytat-app/App.tsx`

**Interfaces:**
- Consumes: `useGoogleSignIn`, `exchangeCodeForTokens`, `getValidAccessToken`, `makeApi`, `loadTokens`, `clearTokens`
- Produces: `useAuth(): { status: 'loading'|'signedOut'|'signedIn'; signIn(): void; signOut(): void; balance: number|null }`

- [ ] **Step 1: `AuthContext.tsx` 구현**

```tsx
// src/context/AuthContext.tsx
import React, { createContext, useContext, useEffect, useState } from 'react';
import { useGoogleSignIn, exchangeCodeForTokens, getValidAccessToken } from '../lib/auth';
import { loadTokens, clearTokens } from '../lib/secure-store';
import { makeApi } from '../lib/api';

type Status = 'loading' | 'signedOut' | 'signedIn';
type Ctx = { status: Status; balance: number | null; signIn: () => void; signOut: () => void };
const AuthCtx = createContext<Ctx>(null as any);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [balance, setBalance] = useState<number | null>(null);
  const { request, response, promptAsync } = useGoogleSignIn();
  const api = makeApi(getValidAccessToken);

  // 부팅 시 저장 토큰 확인
  useEffect(() => {
    loadTokens().then(t => setStatus(t ? 'signedIn' : 'signedOut'));
  }, []);

  // OAuth 응답 처리
  useEffect(() => {
    if (response?.type === 'success' && response.params.code && request?.codeVerifier) {
      exchangeCodeForTokens(response.params.code, request.codeVerifier)
        .then(() => setStatus('signedIn'))
        .catch(() => setStatus('signedOut'));
    }
  }, [response]);

  // 로그인되면 잔액 조회
  useEffect(() => {
    if (status === 'signedIn') {
      api.fetchCredits().then(r => setBalance(r.balance)).catch(() => setBalance(null));
    }
  }, [status]);

  return (
    <AuthCtx.Provider value={{
      status, balance,
      signIn: () => promptAsync(),
      signOut: async () => { await clearTokens(); setBalance(null); setStatus('signedOut'); },
    }}>{children}</AuthCtx.Provider>
  );
}
```

- [ ] **Step 2: 화면 2개 구현**

```tsx
// src/screens/SignInScreen.tsx
import { View, Text, Button } from 'react-native';
import { useAuth } from '../context/AuthContext';
export default function SignInScreen() {
  const { signIn } = useAuth();
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: '700' }}>자막 자동 번역&등록기</Text>
      <Button title="구글로 로그인" onPress={signIn} />
    </View>
  );
}
```

```tsx
// src/screens/HomeScreen.tsx
import { View, Text, Button } from 'react-native';
import { useAuth } from '../context/AuthContext';
export default function HomeScreen() {
  const { balance, signOut } = useAuth();
  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 }}>
      <Text style={{ fontSize: 16 }}>로그인됨</Text>
      <Text style={{ fontSize: 28, fontWeight: '800' }}>
        {balance == null ? '잔액 불러오는 중…' : `${balance.toLocaleString()} 크레딧`}
      </Text>
      <Button title="로그아웃" onPress={signOut} />
    </View>
  );
}
```

- [ ] **Step 3: `App.tsx` 게이팅**

```tsx
// App.tsx
import { AuthProvider, useAuth } from './src/context/AuthContext';
import SignInScreen from './src/screens/SignInScreen';
import HomeScreen from './src/screens/HomeScreen';
import { View, Text } from 'react-native';

function Root() {
  const { status } = useAuth();
  if (status === 'loading') return <View style={{flex:1,justifyContent:'center',alignItems:'center'}}><Text>불러오는 중…</Text></View>;
  return status === 'signedIn' ? <HomeScreen /> : <SignInScreen />;
}
export default function App() {
  return <AuthProvider><Root /></AuthProvider>;
}
```

- [ ] **Step 4: 수동 E2E 검증 (실기기/시뮬레이터)**

전제: Task 2의 iosClientId/androidClientId를 실제 발급값으로 교체 + GCP OAuth 동의화면에 `youtube.force-ssl` 등록.

Run: `npx expo start` → iOS 시뮬레이터/실기기에서 실행
Expected:
1. 첫 화면 "구글로 로그인" 표시
2. 버튼 → 구글 로그인 → 유튜브 권한 동의
3. 홈으로 전환, `N 크레딧` 표시 (웹에서 충전한 잔액)
4. 앱 재시작 시 로그인 유지(홈 바로 진입)
5. 로그아웃 → 로그인 화면 복귀

- [ ] **Step 5: Commit**

```bash
git add App.tsx src/context/AuthContext.tsx src/screens/
git commit -m "feat(app): auth-gated home showing credit balance"
```

---

## Self-Review

**1. Spec 커버리지 (Plan 1 범위):** 스펙 §3(스택)·§4(재사용: OAuth·API·저장소)·§5(로그인→세션→잔액)을 Task 1~6이 구현. Plan 1 범위 밖(영상목록·번역·이력·수익화)은 Plan 2~5로 명시.
**2. Placeholder 스캔:** iosClientId/androidClientId는 "설정값"으로 명시(코드 placeholder 아님) — 발급 필요를 Global Constraints + Task 2/6에 기재. 그 외 TBD/TODO 없음.
**3. 타입 일관성:** `TokenSet`(secure-store) → auth.ts·api.ts에서 동일 사용. `getValidAccessToken`(auth) → api `makeApi(getToken)` 주입 → AuthContext에서 연결. `fetchCredits` 반환형 `{balance,tier,multiplier}` 일관.

## 후속 플랜 (Phase 1 MVP 나머지 — 이 플랜 승인 후 순차 작성)
- **Plan 2**: 유튜브 영상 목록 (YouTube Data API 직접 호출 + 선택 UI)
- **Plan 3**: 번역 플로우 (언어 선택 → /translate/job·/chunk·PATCH 재사용 → 자막/제목/설명 업로드 → 실패 무과금)
- **Plan 4**: 이력·공지·잔액 갱신 + i18n
- **Plan 5**: 수익화 (IAP 크레딧 + Google Ad Manager 광고 + 리워드→크레딧)
