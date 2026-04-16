function renderTemplate(template, recipient) {
  const values = {
    name: recipient.name || "",
    email: recipient.email || "",
    company: recipient.company || "",
  };

  return String(template || "").replace(/{{\s*(name|email|company)\s*}}/gi, (_, key) => {
    return values[key.toLowerCase()] || "";
  });
}

module.exports = {
  renderTemplate,
};

