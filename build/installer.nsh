; Welcome page of the assisted installer: says who made the program before anything is installed.
; Saved as UTF-8 with BOM so makensis reads the Korean text correctly.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "업무포털 도우미 설치"
  !define MUI_WELCOMEPAGE_TEXT "이 프로그램은 등촌중학교 김형훈(HooniKim)이 만들었습니다.$\r$\n$\r$\n화면 가장자리의 작은 위젯에서 나이스와 K-에듀파인을 바로 열어 주는 업무 도우미입니다.$\r$\n$\r$\n교육부·서울특별시교육청의 공식 프로그램이 아닌 개인이 만든 도구입니다.$\r$\n$\r$\n계속하려면 [다음]을 누르세요."
  !insertmacro MUI_PAGE_WELCOME
!macroend
