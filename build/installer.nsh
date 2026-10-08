; Welcome page of the assisted installer: says who made the program before anything is installed.
; Saved as UTF-8 with BOM so makensis reads the Korean text correctly.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "업무포털 도우미 설치"
  !define MUI_WELCOMEPAGE_TEXT "이 프로그램은 등촌중학교 김형훈(HooniKim)이 만들었습니다.$\r$\n$\r$\n화면 가장자리의 작은 위젯에서 나이스와 K-에듀파인을 바로 열어 주는 업무 도우미입니다.$\r$\n$\r$\n교육부·서울특별시교육청의 공식 프로그램이 아닌 개인이 만든 도구입니다.$\r$\n$\r$\n계속하려면 [다음]을 누르세요."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Always a per-user install (C:\Users\<user>\AppData\Local\Programs\EduDock): no admin rights to
; install, update or remove, and no "install for whom" page. Silent updates of an existing
; per-machine install do not show this page and keep updating where they are.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; On removal the teacher chooses whether settings, saved drafts and the saved certificate password
; go too. An update also runs the uninstaller first; it never asks and never deletes anything.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; "Windows 시작할 때 실행" entry (src/login-item.cjs); an update keeps it.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "EduDock"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "EduDock"
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "설정, 저장한 초안, 저장한 인증서 비밀번호도 함께 지울까요?$\r$\n$\r$\n[예] 모두 지웁니다.$\r$\n[아니요] 남겨 두어, 다시 설치하면 그대로 쓸 수 있습니다." /SD IDNO IDNO keepUserData
      ${if} $installMode == "all"
        SetShellVarContext current
      ${endif}
      RMDir /r "$APPDATA\edudock"
      RMDir /r "$LOCALAPPDATA\edudock-updater"
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    keepUserData:
  ${endIf}
!macroend
