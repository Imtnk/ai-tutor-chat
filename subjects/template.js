/* Blank template for a subject profile. Copy this file, fill it in, and pass
   it as `subject` to TutorChat.mount(). */
window.TutorSubjects = window.TutorSubjects || {};
window.TutorSubjects.template = {
  name: "Your Tutor Name",

  systemTemplate: [
    "You are a tutor for <SUBJECT>.",
    "Answer ONLY questions within <SCOPE>.",
    "",
    "Guidelines:",
    "- Be concise and clear.",
    "- Explain at a level appropriate for <AUDIENCE>.",
    "- If the question is outside scope, politely decline and refocus.",
    "- Use web_search when you need current information or to verify facts.",
    "{{CONTEXT}}"
  ].join("\n")

  // Optional: return extra context injected into the {{CONTEXT}} slot above,
  // e.g. the user's current question, page, or progress.
  // contextBuilder: function(){ return ""; }
};
