// Settings for the ENAI Ambassador Training app.
// The publishable key is meant to be public: the database's security rules
// make sure each ambassador can only read and change their own data.
window.APP_CONFIG = {
  SUPABASE_URL: "https://gfdnsqwjnmpxodarjjcn.supabase.co",
  SUPABASE_KEY: "sb_publishable_UU1WLVMnuJzzvBpXLy46Iw_nmkRoXDa",

  // Google Form for field-mission uploads (screenshots). Leave empty until the form exists.
  FIELD_MISSION_FORM_URL: "",

  // Module content files, exported from the Claude Doc tabs as Markdown.
  MODULE_FILES: [
    "content/module-1.md",
    "content/module-2.md",
    "content/module-3.md",
    "content/module-4.md",
    "content/module-5.md",
    "content/module-6.md",
    "content/module-7.md"
  ],

  SUPPORT_EMAIL: "info@academicintegrity.eu"
};
