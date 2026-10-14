# 수진쌤 메모

폰과 PC에 설치해서 쓰는 개인 메모장입니다.

- 작성·수정 날짜와 시간 자동 기록
- 수정·삭제, 검색, 고정, 할 일 체크
- 이미지·영상·파일 첨부 (붙여넣기, 끌어다 놓기, 파일 선택)
- 링크는 눌러서 열 수 있게 자동 변환
- 폰과 PC 실시간 동기화
- 오프라인에서도 열리고, 글 메모는 연결되면 자동 전송
- 텍스트 내보내기, 다크 모드

저장은 Supabase(무료 요금제)를 씁니다. 첨부 저장 공간은 총 1GB, 파일 1개 최대 50MB입니다.
긴 영상은 유튜브·구글드라이브 링크로 붙이는 것을 권장합니다.

---

## 1. Supabase 준비 (처음 한 번)

1. https://supabase.com 가입 → **New project**
   - Name: `memo-app`, Region: **Northeast Asia (Seoul)**
   - Database Password는 따로 적어두세요 (앱에는 쓰지 않습니다)
2. 왼쪽 메뉴 **SQL Editor** → **New query** → `supabase-setup.sql` 내용을 전부 붙여넣고 **Run**
   - 아래쪽에 `Success`가 나오면 완료
3. 왼쪽 메뉴 **Authentication → Sign In / Providers → Email**
   - Email 로그인이 켜져 있는지 확인
   - 혼자 쓰는 앱이므로 **Confirm email**을 끄면 가입 즉시 로그인됩니다 (켜두면 인증 메일 링크를 한 번 눌러야 합니다)
4. **Authentication → URL Configuration**의 Site URL에 앱 주소(3단계에서 받는 GitHub Pages 주소)를 넣습니다
5. **Project Settings → API** (또는 Data API)에서 두 값을 복사합니다
   - Project URL
   - `anon` `public` 키
6. `config.js` 파일의 두 칸에 붙여넣습니다

> `service_role` 키는 절대 넣지 마세요. `anon` 키는 공개되어도 괜찮습니다. 메모와 파일은 DB 규칙으로 로그인한 본인만 접근할 수 있습니다.

## 2. 혼자 쓰려면 가입 막기 (권장)

수진쌤 계정을 만든 뒤 **Authentication → Sign In / Providers**에서 **Allow new users to sign up**을 끄세요.
앱 주소를 아는 다른 사람이 계정을 만들어 저장 공간을 쓰는 것을 막습니다.

## 3. GitHub Pages로 올리기

1. 저장소 **Settings → Pages**
2. Source: **Deploy from a branch**, Branch: **main** / **(root)** → Save
3. 1~2분 뒤 `https://아이디.github.io/memo-app/` 주소가 생깁니다

## 4. 설치하기

| 기기 | 방법 |
|---|---|
| 아이폰 | Safari로 앱 주소 열기 → 공유 버튼 → **홈 화면에 추가** |
| 안드로이드 | Chrome으로 열기 → 메뉴(⋮) → **앱 설치** 또는 **홈 화면에 추가** |
| PC (Chrome·Edge) | 주소창 오른쪽 **설치** 아이콘 → 설치 |

설치한 아이콘으로 처음 열 때 한 번 로그인하면 계속 유지됩니다.

## 알아둘 점

- 일주일 동안 아무도 쓰지 않으면 Supabase 무료 프로젝트가 일시 정지됩니다. 대시보드에서 다시 켜면 데이터는 그대로입니다.
- 파일 첨부와 파일 열기는 인터넷 연결이 필요합니다.
- 계정 메뉴(사람 아이콘)에서 첨부 사용량을 볼 수 있습니다.
- 앱을 고친 뒤에는 앱을 한 번 껐다 켜면 새 버전이 적용됩니다.
