export interface RegionalTerms {
  language: string;
  greeting: (name?: string) => string;
  closing: string;
  companySignature: string;
  positionTitle: string;
  offerIntro: (name?: string) => string;
  compensationHeading: string;
  salaryHeading: string;
  checkInHeading: string;
  vipHeading: string;
  whatWeOfferHeading: string;
  acceptHeading: string;
  acceptDescription: string;
  expiryWarning: string;
  welcomeMessage: string;
  workingDays: string;
  salary: string;
  checkInDay: string;
  bonus: string;
  vipLevel: string;
  profitDeal: string;
  frequency: string;
  minimumTaskNote: string;
  nextStepsHeading: string;
  dateFormat: "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";
  offerBenefits: string[];
  legalDisclaimer: string;
}

const COUNTRY_TO_REGION: Record<string, string> = {};

const LATIN_AMERICA = [
  "Argentina", "Bolivia", "Brazil", "Chile", "Colombia", "Costa Rica", "Cuba",
  "Dominican Republic", "Ecuador", "El Salvador", "Guatemala", "Honduras",
  "Mexico", "Nicaragua", "Panama", "Paraguay", "Peru", "Puerto Rico",
  "Uruguay", "Venezuela"
];

const PORTUGUESE_COUNTRIES = ["Brazil", "Portugal", "Angola", "Mozambique", "Cape Verde", "Guinea-Bissau"];

const FRENCH_COUNTRIES = [
  "France", "Belgium", "Senegal", "Ivory Coast", "Cameroon", "Congo",
  "Democratic Republic of the Congo", "Mali", "Burkina Faso", "Niger",
  "Guinea", "Chad", "Madagascar", "Haiti", "Tunisia", "Morocco", "Algeria",
  "Benin", "Togo", "Central African Republic", "Gabon", "Rwanda", "Burundi",
  "Comoros", "Djibouti"
];

const CHINESE_COUNTRIES = ["China", "Taiwan", "Hong Kong", "Macau", "Singapore"];

const HINDI_COUNTRIES = ["India"];

const SPANISH_COUNTRIES = LATIN_AMERICA.filter(c => c !== "Brazil");

SPANISH_COUNTRIES.forEach(c => COUNTRY_TO_REGION[c] = "es");
PORTUGUESE_COUNTRIES.forEach(c => COUNTRY_TO_REGION[c] = "pt");
FRENCH_COUNTRIES.forEach(c => COUNTRY_TO_REGION[c] = "fr");
CHINESE_COUNTRIES.forEach(c => COUNTRY_TO_REGION[c] = "zh");
HINDI_COUNTRIES.forEach(c => COUNTRY_TO_REGION[c] = "hi");

export function detectLanguageFromCountry(country?: string | null): string {
  if (!country) return "en";
  const normalized = country.trim();
  const exact = COUNTRY_TO_REGION[normalized];
  if (exact) return exact;
  const lower = normalized.toLowerCase();
  for (const [key, lang] of Object.entries(COUNTRY_TO_REGION)) {
    if (key.toLowerCase() === lower) return lang;
  }
  return "en";
}

export function getRegionalTerms(country?: string | null): RegionalTerms {
  const lang = detectLanguageFromCountry(country);

  switch (lang) {
    case "es":
      return {
        language: "es",
        greeting: (name) => name ? `Estimado/a <strong>${name}</strong>,` : `Estimado/a Candidato/a,`,
        closing: "Atentamente,",
        companySignature: "Equipo de Reclutamiento de The Metrics",
        positionTitle: "Asociado Remoto de Carga de Información de Productos",
        offerIntro: (name) => `Nos complace extenderle una oferta de empleo para el puesto de <strong>Asociado Remoto de Carga de Información de Productos</strong> en <strong>The Metrics Inc.</strong>`,
        compensationHeading: "Detalles de Compensación",
        salaryHeading: "Lista de Salarios",
        checkInHeading: "Bono por Actividad de Check-In",
        vipHeading: "Ganancias por Membresía VIP",
        whatWeOfferHeading: "Lo Que Ofrecemos",
        acceptHeading: "Aceptar Su Oferta",
        acceptDescription: "Para aceptar esta oferta, haga clic en el botón a continuación para completar su información y programar su sesión de capacitación. Este enlace expirará en <strong>7 días</strong>.",
        expiryWarning: "<strong>Importante:</strong> Esta oferta expira en 7 días. Por favor complete su aceptación antes de la fecha límite.",
        welcomeMessage: "¡Esperamos darle la bienvenida al equipo!",
        workingDays: "Días de Trabajo",
        salary: "Salario (USD)",
        checkInDay: "Día de Check-In",
        bonus: "Bono (USD)",
        vipLevel: "Nivel VIP",
        profitDeal: "Ganancia / Operación",
        frequency: "Frecuencia",
        minimumTaskNote: `Mínimo <strong style="color: #0f172a;">2 conjuntos de tareas diarias</strong> requeridos para elegibilidad salarial.`,
        nextStepsHeading: "Próximos Pasos",
        dateFormat: "DD/MM/YYYY",
        offerBenefits: [
          "Trabajo remoto flexible — trabaje desde cualquier lugar",
          "Programa de capacitación integral proporcionado",
          "Compensación competitiva basada en rendimiento",
          "Oportunidades de crecimiento dentro de la organización",
        ],
        legalDisclaimer: "Esta oferta constituye un acuerdo de colaboración independiente y está sujeta a los términos y condiciones de The Metrics Inc.",
      };

    case "pt":
      return {
        language: "pt",
        greeting: (name) => name ? `Prezado(a) <strong>${name}</strong>,` : `Prezado(a) Candidato(a),`,
        closing: "Atenciosamente,",
        companySignature: "Equipe de Recrutamento da The Metrics",
        positionTitle: "Associado Remoto de Upload de Insights de Produtos",
        offerIntro: (name) => `Temos o prazer de lhe oferecer a posição de <strong>Associado Remoto de Upload de Insights de Produtos</strong> na <strong>The Metrics Inc.</strong>`,
        compensationHeading: "Detalhes de Compensação",
        salaryHeading: "Tabela Salarial",
        checkInHeading: "Bônus de Atividade de Check-In",
        vipHeading: "Ganhos com Membros VIP",
        whatWeOfferHeading: "O Que Oferecemos",
        acceptHeading: "Aceitar Sua Oferta",
        acceptDescription: "Para aceitar esta oferta, clique no botão abaixo para preencher suas informações e agendar sua sessão de treinamento. Este link expirará em <strong>7 dias</strong>.",
        expiryWarning: "<strong>Importante:</strong> Esta oferta expira em 7 dias. Por favor, conclua sua aceitação antes do prazo.",
        welcomeMessage: "Estamos ansiosos para recebê-lo(a) na equipe!",
        workingDays: "Dias de Trabalho",
        salary: "Salário (USD)",
        checkInDay: "Dia de Check-In",
        bonus: "Bônus (USD)",
        vipLevel: "Nível VIP",
        profitDeal: "Lucro / Operação",
        frequency: "Frequência",
        minimumTaskNote: `Mínimo de <strong style="color: #0f172a;">2 conjuntos de tarefas diárias</strong> necessários para elegibilidade salarial.`,
        nextStepsHeading: "Próximos Passos",
        dateFormat: "DD/MM/YYYY",
        offerBenefits: [
          "Trabalho remoto flexível — trabalhe de qualquer lugar",
          "Programa de treinamento abrangente fornecido",
          "Compensação competitiva baseada em desempenho",
          "Oportunidades de crescimento dentro da organização",
        ],
        legalDisclaimer: "Esta oferta constitui um acordo de colaboração independente e está sujeita aos termos e condições da The Metrics Inc.",
      };

    case "fr":
      return {
        language: "fr",
        greeting: (name) => name ? `Cher(e) <strong>${name}</strong>,` : `Cher(e) Candidat(e),`,
        closing: "Cordialement,",
        companySignature: "L'Équipe de Recrutement de The Metrics",
        positionTitle: "Associé(e) à Distance pour le Téléchargement d'Informations Produits",
        offerIntro: (name) => `Nous avons le plaisir de vous proposer le poste d'<strong>Associé(e) à Distance pour le Téléchargement d'Informations Produits</strong> chez <strong>The Metrics Inc.</strong>`,
        compensationHeading: "Détails de Rémunération",
        salaryHeading: "Grille Salariale",
        checkInHeading: "Bonus d'Activité de Check-In",
        vipHeading: "Revenus d'Adhésion VIP",
        whatWeOfferHeading: "Ce Que Nous Offrons",
        acceptHeading: "Accepter Votre Offre",
        acceptDescription: "Pour accepter cette offre, cliquez sur le bouton ci-dessous pour compléter vos informations et planifier votre session de formation. Ce lien expirera dans <strong>7 jours</strong>.",
        expiryWarning: "<strong>Important :</strong> Cette offre expire dans 7 jours. Veuillez compléter votre acceptation avant la date limite.",
        welcomeMessage: "Nous avons hâte de vous accueillir dans l'équipe !",
        workingDays: "Jours de Travail",
        salary: "Salaire (USD)",
        checkInDay: "Jour de Check-In",
        bonus: "Bonus (USD)",
        vipLevel: "Niveau VIP",
        profitDeal: "Profit / Opération",
        frequency: "Fréquence",
        minimumTaskNote: `Minimum de <strong style="color: #0f172a;">2 séries de tâches quotidiennes</strong> requis pour l'éligibilité salariale.`,
        nextStepsHeading: "Prochaines Étapes",
        dateFormat: "DD/MM/YYYY",
        offerBenefits: [
          "Travail à distance flexible — travaillez de n'importe où",
          "Programme de formation complet fourni",
          "Rémunération compétitive basée sur la performance",
          "Opportunités de croissance au sein de l'organisation",
        ],
        legalDisclaimer: "Cette offre constitue un accord de collaboration indépendante et est soumise aux termes et conditions de The Metrics Inc.",
      };

    case "zh":
      return {
        language: "zh",
        greeting: (name) => name ? `尊敬的 <strong>${name}</strong>：` : `尊敬的候选人：`,
        closing: "此致敬礼，",
        companySignature: "The Metrics 招聘团队",
        positionTitle: "远程产品信息上传专员",
        offerIntro: (name) => `我们很高兴向您提供 <strong>The Metrics Inc.</strong> 的<strong>远程产品信息上传专员</strong>职位。`,
        compensationHeading: "薪酬详情",
        salaryHeading: "薪资表",
        checkInHeading: "签到活动奖金",
        vipHeading: "VIP会员收益",
        whatWeOfferHeading: "我们提供",
        acceptHeading: "接受您的录用",
        acceptDescription: "要接受此录用，请点击下方按钮填写您的信息并安排培训课程。此链接将在 <strong>7天</strong> 后过期。",
        expiryWarning: "<strong>重要提示：</strong> 此录用将在7天后过期。请在截止日期前完成接受流程。",
        welcomeMessage: "我们期待您加入团队！",
        workingDays: "工作天数",
        salary: "薪资 (USD)",
        checkInDay: "签到日",
        bonus: "奖金 (USD)",
        vipLevel: "VIP等级",
        profitDeal: "利润/交易",
        frequency: "频率",
        minimumTaskNote: `每日最低 <strong style="color: #0f172a;">2组任务</strong> 才有资格获得薪资。`,
        nextStepsHeading: "后续步骤",
        dateFormat: "YYYY-MM-DD",
        offerBenefits: [
          "灵活的远程工作 — 随时随地工作",
          "提供全面的培训计划",
          "具有竞争力的绩效薪酬",
          "组织内的成长机会",
        ],
        legalDisclaimer: "本录用函构成独立合作协议，受 The Metrics Inc. 条款和条件的约束。",
      };

    case "hi":
      return {
        language: "hi",
        greeting: (name) => name ? `प्रिय <strong>${name}</strong>,` : `प्रिय उम्मीदवार,`,
        closing: "सादर,",
        companySignature: "The Metrics भर्ती टीम",
        positionTitle: "रिमोट प्रोडक्ट इनसाइट्स अपलोड एसोसिएट",
        offerIntro: (name) => `हमें आपको <strong>The Metrics Inc.</strong> में <strong>रिमोट प्रोडक्ट इनसाइट्स अपलोड एसोसिएट</strong> पद के लिए नौकरी का प्रस्ताव देते हुए खुशी हो रही है।`,
        compensationHeading: "वेतन विवरण",
        salaryHeading: "वेतन सूची",
        checkInHeading: "चेक-इन गतिविधि बोनस",
        vipHeading: "VIP सदस्यता आय",
        whatWeOfferHeading: "हम क्या प्रदान करते हैं",
        acceptHeading: "अपना प्रस्ताव स्वीकार करें",
        acceptDescription: "इस प्रस्ताव को स्वीकार करने के लिए, नीचे दिए गए बटन पर क्लिक करके अपनी जानकारी भरें और अपने प्रशिक्षण सत्र का समय निर्धारित करें। यह लिंक <strong>7 दिनों</strong> में समाप्त हो जाएगा।",
        expiryWarning: "<strong>महत्वपूर्ण:</strong> यह प्रस्ताव 7 दिनों में समाप्त हो जाएगा। कृपया समय सीमा से पहले अपनी स्वीकृति पूरी करें।",
        welcomeMessage: "हम आपका टीम में स्वागत करने के लिए उत्सुक हैं!",
        workingDays: "कार्य दिवस",
        salary: "वेतन (USD)",
        checkInDay: "चेक-इन दिन",
        bonus: "बोनस (USD)",
        vipLevel: "VIP स्तर",
        profitDeal: "लाभ / सौदा",
        frequency: "आवृत्ति",
        minimumTaskNote: `वेतन पात्रता के लिए प्रतिदिन न्यूनतम <strong style="color: #0f172a;">2 कार्य सेट</strong> आवश्यक हैं।`,
        nextStepsHeading: "अगले कदम",
        dateFormat: "DD/MM/YYYY",
        offerBenefits: [
          "लचीला रिमोट कार्य — कहीं से भी काम करें",
          "व्यापक प्रशिक्षण कार्यक्रम प्रदान किया जाता है",
          "प्रदर्शन-आधारित प्रतिस्पर्धी वेतन",
          "संगठन के भीतर विकास के अवसर",
        ],
        legalDisclaimer: "यह प्रस्ताव एक स्वतंत्र सहयोग समझौता है और The Metrics Inc. के नियमों और शर्तों के अधीन है।",
      };

    default:
      return {
        language: "en",
        greeting: (name) => name ? `Dear <strong>${name}</strong>,` : `Hello,`,
        closing: "Best regards,",
        companySignature: "The Metrics Recruitment Team",
        positionTitle: "Remote Product Insights Upload Associate",
        offerIntro: (name) => `We are excited to extend a job offer to you for the <strong>Remote Product Insights Upload Associate</strong> position at <strong>The Metrics Inc.</strong>`,
        compensationHeading: "Compensation Details",
        salaryHeading: "Salary List",
        checkInHeading: "Check-In Activity Bonus",
        vipHeading: "VIP Membership Earnings",
        whatWeOfferHeading: "What We Offer",
        acceptHeading: "Accept Your Offer",
        acceptDescription: "To accept this offer, please click the button below to complete your information and schedule your training session. This link will expire in <strong>7 days</strong>.",
        expiryWarning: "<strong>Important:</strong> This offer expires in 7 days. Please complete your acceptance before the deadline.",
        welcomeMessage: "We look forward to welcoming you to the team!",
        workingDays: "Working Days",
        salary: "Salary (USD)",
        checkInDay: "Check-In Day",
        bonus: "Bonus (USD)",
        vipLevel: "VIP Level",
        profitDeal: "Profit / Deal",
        frequency: "Frequency",
        minimumTaskNote: `Minimum <strong style="color: #0f172a;">2 sets of tasks daily</strong> required for salary eligibility.`,
        nextStepsHeading: "Next Steps",
        dateFormat: "MM/DD/YYYY",
        offerBenefits: [
          "Flexible remote work — work from anywhere",
          "Comprehensive training program provided",
          "Competitive performance-based compensation",
          "Growth opportunities within the organization",
        ],
        legalDisclaimer: "This offer constitutes an independent collaboration agreement and is subject to the terms and conditions of The Metrics Inc.",
      };
  }
}

export const COUNTRY_LIST = [
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda",
  "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan", "Bahamas", "Bahrain",
  "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan",
  "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria",
  "Burkina Faso", "Burundi", "Cambodia", "Cameroon", "Canada", "Cape Verde",
  "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros",
  "Congo", "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czech Republic",
  "Democratic Republic of the Congo", "Denmark", "Djibouti", "Dominica",
  "Dominican Republic", "East Timor", "Ecuador", "Egypt", "El Salvador",
  "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia", "Fiji",
  "Finland", "France", "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece",
  "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana", "Haiti", "Honduras",
  "Hong Kong", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland",
  "Israel", "Italy", "Ivory Coast", "Jamaica", "Japan", "Jordan", "Kazakhstan",
  "Kenya", "Kiribati", "Kosovo", "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon",
  "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Macau",
  "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands",
  "Mauritania", "Mauritius", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia",
  "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru", "Nepal",
  "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea",
  "North Macedonia", "Norway", "Oman", "Pakistan", "Palau", "Palestine", "Panama",
  "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar",
  "Romania", "Russia", "Rwanda", "Saint Kitts and Nevis", "Saint Lucia",
  "Saint Vincent and the Grenadines", "Samoa", "San Marino", "Saudi Arabia",
  "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia",
  "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Korea",
  "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland",
  "Syria", "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Togo", "Tonga",
  "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu", "Uganda",
  "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Uruguay",
  "Uzbekistan", "Vanuatu", "Vatican City", "Venezuela", "Vietnam", "Yemen", "Zambia",
  "Zimbabwe"
];
