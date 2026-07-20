// ============================================================
// Court Piece -- game engine (ported from the Python codebase)
// No DOM/rendering code lives here -- this file is the same
// "rules brain" as game.py + rules.py + bot.py + player.py,
// so it can be tested on its own before wiring up the UI.
// ============================================================

const SUITS = ["Spades", "Hearts", "Diamonds", "Clubs"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "Jack", "Queen", "King", "Ace"];

const RANK_VALUES = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  "10": 10, "Jack": 11, "Queen": 12, "King": 13, "Ace": 14
};

const SUIT_ORDER = { Spades: 0, Hearts: 1, Diamonds: 2, Clubs: 3 };

function cardValue(card) {
  return RANK_VALUES[card.rank];
}

// ---------------- Deck ----------------

class Deck {
  constructor() {
    this.cards = [];
    this.createDeck();
  }

  createDeck() {
    this.cards = [];
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        this.cards.push({ rank, suit });
      }
    }
  }

  shuffle() {
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  dealCard() {
    if (this.cards.length === 0) return null;
    return this.cards.pop();
  }
}

// ---------------- Rules ----------------
// Mirrors engine/rules.py exactly. playedCards is an array of
// [playerIndex, card] pairs. Returns the winning playerIndex.

const Rules = {
  determineWinner(playedCards, trump) {
    const leadSuit = playedCards[0][1].suit;

    let winningIndex = playedCards[0][0];
    let winningCard = playedCards[0][1];

    for (let i = 1; i < playedCards.length; i++) {
      const [playerIndex, card] = playedCards[i];

      if (card.suit === trump && winningCard.suit !== trump) {
        winningIndex = playerIndex;
        winningCard = card;
      } else if (card.suit === trump && winningCard.suit === trump) {
        if (cardValue(card) > cardValue(winningCard)) {
          winningIndex = playerIndex;
          winningCard = card;
        }
      } else if (
        winningCard.suit !== trump &&
        card.suit === leadSuit &&
        winningCard.suit === leadSuit
      ) {
        if (cardValue(card) > cardValue(winningCard)) {
          winningIndex = playerIndex;
          winningCard = card;
        }
      }
    }

    return winningIndex;
  }
};

// ---------------- Bot AI ----------------
// Mirrors ai/bot.py exactly.

const Bot = {
  beats(card1, card2, leadSuit, trump) {
    if (card1.suit === card2.suit) {
      return cardValue(card1) > cardValue(card2);
    }
    if (card1.suit === trump && card2.suit !== trump) return true;
    if (card2.suit === trump && card1.suit !== trump) return false;
    if (card1.suit === leadSuit && card2.suit !== leadSuit) return true;
    return false;
  },

  chooseCard(playerIndex, hand, leadSuit, playedCards, trump) {
    let validCards = hand;

    if (leadSuit !== null) {
      const suitCards = hand.filter((c) => c.suit === leadSuit);
      if (suitCards.length > 0) validCards = suitCards;
    }

    const lowest = (cards) =>
      cards.reduce((min, c) => (cardValue(c) < cardValue(min) ? c : min), cards[0]);

    if (playedCards.length === 0) {
      return lowest(validCards);
    }

    let currentWinnerIndex = playedCards[0][0];
    let currentWinnerCard = playedCards[0][1];

    for (let i = 1; i < playedCards.length; i++) {
      const [idx, card] = playedCards[i];
      if (this.beats(card, currentWinnerCard, leadSuit, trump)) {
        currentWinnerCard = card;
        currentWinnerIndex = idx;
      }
    }

    const myTeam = playerIndex % 2;
    const winnerTeam = currentWinnerIndex % 2;

    if (myTeam === winnerTeam) {
      return lowest(validCards);
    }

    const winningCards = validCards.filter((c) =>
      this.beats(c, currentWinnerCard, leadSuit, trump)
    );

    if (winningCards.length > 0) {
      return lowest(winningCards);
    }

    return lowest(validCards);
  }
};

// ---------------- Player ----------------

function makePlayer(name, playerId) {
  return {
    name,
    playerId,
    hand: [],
    tricks: 0,
    isHuman: false
  };
}

function sortHand(player) {
  player.hand.sort((a, b) => {
    const suitDiff = SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
    if (suitDiff !== 0) return suitDiff;
    return RANK_VALUES[b.rank] - RANK_VALUES[a.rank];
  });
}

// Simple heuristic for a bot picking a NEW trump suit (needed
// whenever dealer+1 or a mid-round challenger happens to be a bot --
// the Python GUI never solved this; the web version does, so a bot
// dealer's seat never stalls the game).
function botPickTrumpSuit(player) {
  const counts = { Spades: 0, Hearts: 0, Diamonds: 0, Clubs: 0 };
  for (const card of player.hand) counts[card.suit]++;

  let best = SUITS[0];
  for (const suit of SUITS) {
    if (counts[suit] > counts[best]) best = suit;
  }
  return best;
}

// ---------------- Game engine ----------------

class Game {
  constructor() {
    this.players = [
      makePlayer("Player 1", 0),
      makePlayer("Player 2", 1),
      makePlayer("Player 3", 2),
      makePlayer("Player 4", 3)
    ];
    this.players[0].isHuman = true;

    this.deck = new Deck();

    this.trump = null;
    this.trumpPlayerIndex = null;
    this.trumpTeam = null;

    this.dealer = 3;
    this.roundNumber = 1;
    this.team1Score = 0;
    this.team2Score = 0;

    this.currentPlayer = 0;

    this.challengeMode = false;
    this.challengePlayerIndex = null;
    this.challengeTeam = null;

    this.unclaimedTricks = 0;
    this.lastWinnerIndex = null;
    this.consecutiveWins = 0;
    this.lastCapturedCount = 0;
  }

  teamOf(playerIndex) {
    return playerIndex % 2 === 0 ? 1 : 2;
  }

  teamTricks() {
    const team1 = this.players[0].tricks + this.players[2].tricks;
    const team2 = this.players[1].tricks + this.players[3].tricks;
    return { team1, team2 };
  }

  resetRound() {
    this.deck = new Deck();
    this.deck.shuffle();

    this.trump = null;
    this.trumpPlayerIndex = null;
    this.trumpTeam = null;

    this.challengeMode = false;
    this.challengePlayerIndex = null;
    this.challengeTeam = null;

    this.unclaimedTricks = 0;
    this.lastWinnerIndex = null;
    this.consecutiveWins = 0;

    this.currentPlayer = 0;

    for (const player of this.players) {
      player.hand = [];
      player.tricks = 0;
    }
  }

  // Deals one card at a time starting at the current dealer, cycling
  // until a Jack turns up; that player becomes the dealer.
  jackToss() {
    this.deck = new Deck();
    this.deck.shuffle();

    const draws = [];

    while (true) {
      for (let i = 0; i < 4; i++) {
        const playerIndex = (this.dealer + i) % 4;
        const card = this.deck.dealCard();
        draws.push({ playerIndex, card });

        if (card.rank === "Jack") {
          this.dealer = playerIndex;
          return draws;
        }
      }
    }
  }

  dealFirstFive() {
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 4; i++) {
        const player = this.players[(this.dealer + i) % 4];
        const card = this.deck.dealCard();
        if (card) player.hand.push(card);
      }
    }
  }

  dealRemainingCards() {
    for (let round = 0; round < 8; round++) {
      for (let i = 0; i < 4; i++) {
        const player = this.players[(this.dealer + i) % 4];
        const card = this.deck.dealCard();
        if (card) player.hand.push(card);
      }
    }
    for (const player of this.players) {
      sortHand(player);
    }
  }

  // First trump choice is always dealer+1.
  initialTrumpChooserIndex() {
    return (this.dealer + 1) % 4;
  }

  chooseTrump(suit, chooserIndex) {
    this.trump = suit;
    this.trumpPlayerIndex = chooserIndex;
    this.trumpTeam = this.teamOf(chooserIndex);
    for (const player of this.players) sortHand(player);
  }

  // Rotation covers all 4 players: dealer+2, dealer+3, dealer,
  // dealer+1 (the original chooser gets the final say).
  challengeOrderIndexForStep(step) {
    return (this.dealer + 2 + step) % 4;
  }

  applyChallenge(newChooserIndex) {
    this.challengeMode = true;
    this.challengePlayerIndex = newChooserIndex;
    this.challengeTeam = this.teamOf(newChooserIndex);
    this.trumpPlayerIndex = newChooserIndex;
    this.trumpTeam = this.teamOf(newChooserIndex);
  }

  // Tricks pool up until a player wins 2 in a row, then claims the
  // whole pool. Trick 13 is a hard flush regardless of streak.
  // Returns { capturedIndex, capturedCount } or null.
  updateScore(winnerIndex, trickNumber) {
    this.unclaimedTricks += 1;

    if (this.lastWinnerIndex === winnerIndex) {
      this.consecutiveWins += 1;
    } else {
      this.lastWinnerIndex = winnerIndex;
      this.consecutiveWins = 1;
    }

    let result = null;

    if (this.consecutiveWins === 2) {
      this.players[winnerIndex].tricks += this.unclaimedTricks;
      result = { capturedIndex: winnerIndex, capturedCount: this.unclaimedTricks };
      this.lastCapturedCount = this.unclaimedTricks;

      this.unclaimedTricks = 0;
      this.consecutiveWins = 0;
      this.lastWinnerIndex = null;
    } else if (trickNumber === 13) {
      this.players[winnerIndex].tricks += this.unclaimedTricks;
      result = { capturedIndex: winnerIndex, capturedCount: this.unclaimedTricks };
      this.lastCapturedCount = this.unclaimedTricks;

      this.unclaimedTricks = 0;
    }

    return result;
  }

  // Unified dealer-rotation rule:
  // - Trump team succeeded -> same dealer continues.
  // - Trump team failed:
  //     - failing team IS the dealer's own team (only possible via a
  //       mid-round challenge from the dealer's partner) -> new
  //       dealer = dealer + 2 (the partner, since the dealer already
  //       dealt this round).
  //     - otherwise -> new dealer = dealer + 1.
  rotateDealer(trumpTeamSucceeded) {
    if (trumpTeamSucceeded) return;

    const dealerTeam = this.teamOf(this.dealer);

    if (this.trumpTeam === dealerTeam) {
      this.dealer = (this.dealer + 2) % 4;
    } else {
      this.dealer = (this.dealer + 1) % 4;
    }
  }

  matchOver() {
    return this.team1Score >= 5 || this.team2Score >= 5;
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    SUITS, RANKS, RANK_VALUES, SUIT_ORDER,
    cardValue, Deck, Rules, Bot,
    makePlayer, sortHand, botPickTrumpSuit,
    Game
  };
}
