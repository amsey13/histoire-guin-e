const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

const PORT = process.env.PORT || 3000;
const QUESTION_TIMER_SECONDS = 20; // 20 secondes par question

// Servir les fichiers statiques depuis public/
app.use(express.static(path.join(__dirname, 'public')));

// Récupérer l'adresse IP locale pour faciliter la connexion mobile en local
function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

// Endpoint pour que l'écran Hôte connaisse l'adresse réelle (cloud ou locale)
app.get('/api/server-info', (req, res) => {
  // Si le serveur tourne sur un hébergeur cloud (ex: Render, Railway, etc.), on utilise l'en-tête Host de la requête
  const host = req.get('host');
  const protocol = req.protocol || (req.get('x-forwarded-proto') ? req.get('x-forwarded-proto') : 'http');
  const isCloudOrCustom = host && !host.includes('localhost') && !host.includes('127.0.0.1');

  if (isCloudOrCustom) {
    const proto = req.get('x-forwarded-proto') || 'https';
    return res.json({
      localIp: host,
      port: PORT,
      joinUrl: `${proto}://${host}/joueur.html`
    });
  }

  const localIp = getLocalIp();
  res.json({
    localIp,
    port: PORT,
    joinUrl: `http://${localIp}:${PORT}/joueur.html`
  });
});

// Données du quiz sur l'histoire de la Guinée
const questions = [
  {
    id: 1,
    question: "En 1958, avant de quitter la Guinée, que font les colons français ?",
    choices: [
      "Ils dévissent les ampoules et coulent du ciment dans les toilettes",
      "Ils brûlent toutes les archives administratives et les casernes",
      "Ils emportent les réserves de riz et empoisonnent les puits",
      "Ils dynamitent les ponts ferroviaires reliant Conakry à Kankan"
    ],
    correct: 0,
    explication: "Après le NON historique au référendum de De Gaulle le 28 septembre 1958, l'administration coloniale a orchestré un sabotage systématique (destruction de dossiers, ampoules dévissées, médicaments jetés et ciment dans les canalisations) pour tenter de paralyser le jeune État souverain."
  },
  {
    id: 2,
    question: "Quel objet personnel de Gaulle aurait-il oublié dans sa fuite de Conakry (légende urbaine) ?",
    choices: [
      "Sa montre à gousset gravée",
      "Son képi militaire",
      "Ses lunettes de lecture en écaille",
      "Son stylo plume officiel"
    ],
    correct: 1,
    explication: "Une célèbre légende urbaine de Conakry raconte que face à la ferveur populaire et au discours intransigeant de Sékou Touré en août 1958, de Gaulle aurait oublié son képi militaire dans la précipitation de son départ."
  },
  {
    id: 3,
    question: "Comment l'Empereur Mansa Moussa a-t-il ruiné l'économie égyptienne en 1324 ?",
    choices: [
      "En achetant l'intégralité des récoltes de blé du Nil",
      "En bloquant le commerce caravanier de sel et d'épices",
      "En distribuant tellement d'or qu'il a perdu sa valeur",
      "En payant les artisans cairotes dix fois le cours normal"
    ],
    correct: 2,
    explication: "Lors de son pèlerinage à La Mecque en 1324, le souverain de l'Empire du Mali (qui englobait une grande partie de la Haute-Guinée) a fait don d'une telle quantité d'or au Caire que le cours du métal précieux s'est effondré pendant plus d'une décennie !"
  },
  {
    id: 4,
    question: "Pourquoi l'Opération Persil des services secrets français échoue-t-elle en 1960 ?",
    choices: [
      "L'avion larguant les cargaisons s'est écrasé au Sénégal",
      "Les faux billets français étaient de trop bonne qualité face à l'humidité de Conakry",
      "Sékou Touré a subitement changé la couleur du franc guinéen",
      "Un agent double infiltré a vendu les plans de sabotage à Moscou"
    ],
    correct: 1,
    explication: "Conçue par Jacques Foccart pour inonder la Guinée de faux francs guinéens et asphyxier l'économie, l'opération a échoué car le papier de la Banque de France était de trop bonne qualité et ne vieillissait pas avec l'humidité tropicale comme les vrais billets, révélant la supercherie."
  },
  {
    id: 5,
    question: "Pendant des siècles, quelle était la principale arme de défense empêchant les colons de pénétrer en Guinée ?",
    choices: [
      "Le relief montagneux du Fouta-Djalon formant une forteresse",
      "Les rois locaux qui bloquaient les routes commerciales",
      "Les moustiques ",
      "Les forêts denses impénétrables de Guinée forestière"
    ],
    correct: 2,
    explication: "La géographie et la politique sont des pièges classiques ! En réalité, ce sont les moustiques vecteurs du paludisme (malaria) et de la fièvre jaune qui décimaient les colons sur la côte. Ce n'est qu'avec l'usage médical de la quinine au XIXe siècle que les armées européennes ont pu s'enfoncer dans les terres."
  }
];

// État global du jeu
const gameState = {
  status: 'LOBBY', // 'LOBBY' | 'QUESTION_ACTIVE' | 'QUESTION_RESULT' | 'PODIUM'
  currentQuestionIndex: -1,
  totalQuestions: questions.length,
  players: {}, // socketId -> { id, nickname, score, hasAnswered, lastAnswer: null, isCorrect: false, pointsEarned: 0, timeTakenSec: 0 }
  answers: {}, // socketId -> choiceIndex
  questionStartTime: null,
  timerInterval: null,
  timeLeft: QUESTION_TIMER_SECONDS,
  votingClosed: false
};

// Utilitaires d'état
function getLeaderboard() {
  return Object.values(gameState.players)
    .sort((a, b) => b.score - a.score)
    .map((p, idx) => ({
      rank: idx + 1,
      id: p.id,
      nickname: p.nickname,
      score: p.score
    }));
}

function getAnswersStats(currentQ) {
  const stats = [0, 0, 0, 0];
  Object.values(gameState.answers).forEach(choice => {
    if (choice >= 0 && choice <= 3) {
      stats[choice]++;
    }
  });
  return stats;
}

function broadcastToHost() {
  io.to('hosts').emit('host:state_update', {
    status: gameState.status,
    currentQuestionIndex: gameState.currentQuestionIndex,
    totalQuestions: gameState.totalQuestions,
    question: gameState.currentQuestionIndex >= 0 ? questions[gameState.currentQuestionIndex] : null,
    players: Object.values(gameState.players),
    playersCount: Object.keys(gameState.players).length,
    answeredCount: Object.keys(gameState.answers).length,
    leaderboard: getLeaderboard(),
    answersStats: gameState.currentQuestionIndex >= 0 ? getAnswersStats(questions[gameState.currentQuestionIndex]) : [0, 0, 0, 0],
    timeLeft: gameState.timeLeft,
    totalTime: QUESTION_TIMER_SECONDS,
    votingClosed: gameState.votingClosed
  });
}

function notifyPlayersQuestionStart(qIndex) {
  const currentQ = questions[qIndex];
  io.emit('player:question_start', {
    questionIndex: qIndex,
    totalQuestions: gameState.totalQuestions,
    questionTitle: currentQ.question,
    totalTime: QUESTION_TIMER_SECONDS
  });
}

// Clôture des votes (fin du chrono ou tout le monde a répondu) : ATTEND que l'animateur révèle
function closeVoting() {
  if (gameState.votingClosed) return;
  gameState.votingClosed = true;

  if (gameState.timerInterval) {
    clearInterval(gameState.timerInterval);
    gameState.timerInterval = null;
  }

  // Notifier les joueurs que le temps de vote est écoulé
  io.emit('game:voting_closed');
  broadcastToHost();
}

// Révélation manuelle déclenchée UNIQUEMENT par l'Hôte
function revealCurrentResult() {
  if (gameState.status !== 'QUESTION_ACTIVE') return;

  if (gameState.timerInterval) {
    clearInterval(gameState.timerInterval);
    gameState.timerInterval = null;
  }
  gameState.votingClosed = true;
  gameState.status = 'QUESTION_RESULT';

  const currentQ = questions[gameState.currentQuestionIndex];

  // Envoyer le verdict individuel à chaque joueur
  Object.values(gameState.players).forEach(p => {
    io.to(p.id).emit('player:question_result', {
      isCorrect: p.isCorrect,
      pointsAdded: p.pointsEarned,
      totalScore: p.score,
      correctChoice: currentQ.correct
    });
  });

  broadcastToHost();
}

function startQuestionTimer() {
  if (gameState.timerInterval) {
    clearInterval(gameState.timerInterval);
  }

  gameState.timeLeft = QUESTION_TIMER_SECONDS;
  gameState.votingClosed = false;

  gameState.timerInterval = setInterval(() => {
    gameState.timeLeft--;

    io.emit('game:timer_tick', {
      timeLeft: gameState.timeLeft,
      totalTime: QUESTION_TIMER_SECONDS
    });

    if (gameState.timeLeft <= 0) {
      clearInterval(gameState.timerInterval);
      gameState.timerInterval = null;
      // À 0 seconde : on ferme les votes mais ON N'AFFICHE PAS la réponse
      closeVoting();
    }
  }, 1000);
}

io.on('connection', (socket) => {
  // Enregistrement d'un écran hôte
  socket.on('host:register', () => {
    socket.join('hosts');
    socket.emit('host:state_update', {
      status: gameState.status,
      currentQuestionIndex: gameState.currentQuestionIndex,
      totalQuestions: gameState.totalQuestions,
      question: gameState.currentQuestionIndex >= 0 ? questions[gameState.currentQuestionIndex] : null,
      players: Object.values(gameState.players),
      playersCount: Object.keys(gameState.players).length,
      answeredCount: Object.keys(gameState.answers).length,
      leaderboard: getLeaderboard(),
      answersStats: gameState.currentQuestionIndex >= 0 ? getAnswersStats(questions[gameState.currentQuestionIndex]) : [0, 0, 0, 0],
      timeLeft: gameState.timeLeft,
      totalTime: QUESTION_TIMER_SECONDS,
      votingClosed: gameState.votingClosed
    });
  });

  // Connexion d'un joueur
  socket.on('player:join', ({ nickname }) => {
    const cleanNick = (nickname || '').trim().slice(0, 15);
    if (!cleanNick) {
      socket.emit('player:join_error', { message: 'Pseudo invalide ou trop court.' });
      return;
    }

    // Vérifier si le pseudo est déjà pris
    const alreadyTaken = Object.values(gameState.players).some(
      p => p.nickname.toLowerCase() === cleanNick.toLowerCase() && p.id !== socket.id
    );

    if (alreadyTaken) {
      socket.emit('player:join_error', { message: 'Ce pseudo est déjà utilisé. Choisis-en un autre !' });
      return;
    }

    gameState.players[socket.id] = {
      id: socket.id,
      nickname: cleanNick,
      score: 0,
      hasAnswered: false,
      lastAnswer: null,
      isCorrect: false,
      pointsEarned: 0,
      timeTakenSec: 0
    };

    socket.emit('player:joined_success', {
      id: socket.id,
      nickname: cleanNick,
      status: gameState.status,
      currentQuestionIndex: gameState.currentQuestionIndex,
      totalTime: QUESTION_TIMER_SECONDS,
      timeLeft: gameState.timeLeft,
      votingClosed: gameState.votingClosed
    });

    broadcastToHost();
  });

  // Hôte : Démarrer le quiz ou passer à la question suivante
  socket.on('host:next_question', () => {
    if (gameState.currentQuestionIndex + 1 < questions.length) {
      gameState.currentQuestionIndex++;
      gameState.status = 'QUESTION_ACTIVE';
      gameState.answers = {};
      gameState.questionStartTime = Date.now();
      gameState.votingClosed = false;

      // Réinitialiser l'état de vote des joueurs pour cette question
      Object.values(gameState.players).forEach(p => {
        p.hasAnswered = false;
        p.lastAnswer = null;
        p.isCorrect = false;
        p.pointsEarned = 0;
        p.timeTakenSec = 0;
      });

      startQuestionTimer();
      notifyPlayersQuestionStart(gameState.currentQuestionIndex);
      broadcastToHost();
    } else {
      // Fin du quiz -> Podium
      if (gameState.timerInterval) {
        clearInterval(gameState.timerInterval);
        gameState.timerInterval = null;
      }
      gameState.status = 'PODIUM';
      io.emit('game:podium', {
        leaderboard: getLeaderboard()
      });
      broadcastToHost();
    }
  });

  // Hôte : Révéler manuellement le résultat de la question en cours
  socket.on('host:reveal_result', () => {
    revealCurrentResult();
  });

  // Joueur : Soumettre une réponse (index de 0 à 3)
  socket.on('player:submit_answer', ({ choiceIndex }) => {
    if (gameState.status !== 'QUESTION_ACTIVE' || gameState.votingClosed) return;

    const player = gameState.players[socket.id];
    if (!player || player.hasAnswered) return;

    if (choiceIndex < 0 || choiceIndex > 3) return;

    const currentQ = questions[gameState.currentQuestionIndex];
    const isCorrect = choiceIndex === currentQ.correct;

    // Calcul du bonus de rapidité
    const elapsedSec = (Date.now() - gameState.questionStartTime) / 1000;
    const remainingRatio = Math.max(0, (QUESTION_TIMER_SECONDS - elapsedSec) / QUESTION_TIMER_SECONDS);
    let points = 0;

    if (isCorrect) {
      const speedBonus = Math.round(100 * remainingRatio);
      points = 100 + speedBonus; // Entre 100 et 200 pts
      player.score += points;
    }

    player.hasAnswered = true;
    player.lastAnswer = choiceIndex;
    player.isCorrect = isCorrect;
    player.pointsEarned = points;
    player.timeTakenSec = elapsedSec.toFixed(1);

    gameState.answers[socket.id] = choiceIndex;

    // Confirmer la réception au joueur
    socket.emit('player:answer_received', {
      choiceIndex
    });

    // Mettre à jour l'hôte
    broadcastToHost();

    // Si tous les joueurs ont répondu, on clôture les votes
    const totalPlayers = Object.keys(gameState.players).length;
    const answeredCount = Object.keys(gameState.answers).length;
    if (totalPlayers > 0 && answeredCount >= totalPlayers) {
      closeVoting();
    }
  });

  // Hôte : Recommencer une nouvelle partie
  socket.on('host:restart_game', () => {
    if (gameState.timerInterval) {
      clearInterval(gameState.timerInterval);
      gameState.timerInterval = null;
    }
    gameState.status = 'LOBBY';
    gameState.currentQuestionIndex = -1;
    gameState.answers = {};
    gameState.votingClosed = false;
    Object.values(gameState.players).forEach(p => {
      p.score = 0;
      p.hasAnswered = false;
      p.lastAnswer = null;
      p.isCorrect = false;
      p.pointsEarned = 0;
      p.timeTakenSec = 0;
    });

    io.emit('game:restarted');
    broadcastToHost();
  });

  // Déconnexion d'un utilisateur
  socket.on('disconnect', () => {
    if (gameState.players[socket.id]) {
      delete gameState.players[socket.id];
      delete gameState.answers[socket.id];
      broadcastToHost();
    }
  });
});

const localIp = getLocalIp();

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🇬🇳 Quiz Histoire de Guinée démarré avec succès !`);
  console.log(`📺 Écran Hôte (Local)  : http://localhost:${PORT}/index.html`);
  console.log(`📱 Écran Joueur Mobile : http://${localIp}:${PORT}/joueur.html`);
  console.log(`====================================================`);
});
