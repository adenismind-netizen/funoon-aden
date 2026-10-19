'use strict';

function welcomeText(submission) {
  return `أهلًا فيكِ 🤍\nشكرًا لإكمالكِ «بوصلة قلبك» من فنون عدن.\n\nقراءتكِ: ${submission.result.patternName}\nهذه قراءة تأملية لإجاباتك وليست تشخيصًا.\n\nدليلكِ المجاني:\n${submission.guideUrl}\n\nالقراءة المقترحة لمرحلتكِ: ${submission.lead.book}\n${submission.bookUrl}\n\nمجتمع فنون عدن:\nhttps://t.me/EdenArtspirtuality\n\n— فنون عدن`;
}

function buildTgAlert(submission) {
  const { lead, result, payload } = submission;
  return `🌷 طلب تواصل جديد — فنون عدن\n\nالاسم: ${lead.name}\nواتساب: ${lead.whatsapp}\nقراءة البوصلة: ${result.patternName}\nالنمط السابق: ${lead.pattern} (${lead.pattern_key})\nالنتائج: A ${lead.scores.A} | B ${lead.scores.B} | C ${lead.scores.C} | D ${lead.scores.D}\nالمرحلة: ${result.context}\nالقراءة المقترحة: ${lead.book}\n${submission.bookUrl}\nالمصدر: ${lead.source}\nالموافقة على التواصل: نعم\nالطلب: ${payload.submissionId}\nhttps://wa.me/${lead.whatsapp.slice(1)}`;
}

module.exports = { welcomeText, buildTgAlert };
