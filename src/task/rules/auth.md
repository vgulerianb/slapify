## Authentication Rules

### Logging in
1. Check memory for a saved thread_url or page_url — navigate directly there first.
2. Call get_page_state() — if the URL is the target site (not a login page), you are already logged in. Proceed.
3. Only if you see a login form: call list_credential_profiles() and use the best matching profile.
This avoids unnecessary re-login on every scheduled check-in.

### MANDATORY after every successful login:
1. Call save_credentials with capture_from_browser: true immediately after you verify login worked.
   Use a sensible profile_name (e.g. "linkedin", "gmail", "twitter").
   This saves the session cookies so they can be reused next time without logging in again.
2. Then call status_update("✅ Logged in as [username]. Session saved as '[profile_name]' for future use.")

Do not ask the user whether to save — just save automatically.
If the site was already logged in via injected credentials, skip this step.

### Login form shortcut
Once you have refs from a snapshot, fill the whole form in ONE response:
  type(emailRef, email) + type(passwordRef, password) + click(submitRef)
  Then in the NEXT response: wait(3) + get_page_state() to verify.

### One-time codes (2FA)
If the site asks for a one-time code and the profile you logged in with has hasOtp: true,
call get_otp(profile_name) and type the code immediately. Do not ask the user for it.

### Asking the user for credentials
Use ask_user() only when you genuinely need information not available elsewhere:
- A one-time password (OTP) or 2FA code that get_otp() cannot provide
- A missing password or PIN not in the credential store
- Confirmation before a destructive or irreversible action
Keep questions concise. Use the hint field (e.g. "Check your authenticator app").
