window.BlackspotVoice = (() => {
  let enabled = true;
  let lastMessage = '';
  let lastSpokenAt = 0;
  function speak(message) {
    if (!enabled || !('speechSynthesis' in window) || !message) return;
    const now = Date.now();
    if (message === lastMessage && now - lastSpokenAt < 12000) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.lang = 'en-IN';
    utterance.rate = 0.92;
    window.speechSynthesis.speak(utterance);
    lastMessage = message;
    lastSpokenAt = now;
  }
  return {
    speak,
    setEnabled(value){enabled=value},
    isEnabled(){return enabled},
  };
})();
