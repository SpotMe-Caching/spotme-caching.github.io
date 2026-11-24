/* Geteilte Daten: Eier, Hinweise, Ränge (index.html + eier.html) */
var EGGS = [
  {id:'snail', ic:'🐌', name:'Schneckenpost', riddle:'Manche Nachrichten haben es nicht eilig.',
   h:['Der Sendeknopf kann mehr als tippen.','Halte den Sendeknopf ➤ gedrückt, statt kurz zu tippen.','Sendeknopf lang drücken: die Nachricht kriecht als Schnecke in den Chat. (Nicht sichtbar, wenn „Animationen entfernen“ am Handy an ist.)']},
  {id:'blow', ic:'💨', name:'Pusten', riddle:'Wer pustet, kommt zurück.',
   h:['Dein Handy hört zu, wenn du es erlaubst.','Im Hub → Aussehen den Schalter „Pusten“ einschalten und Mikrofon erlauben.','Im offenen Chat kräftig ins Mikrofon pusten: du bläst den Chat weg und landest wieder in der Kontaktliste.']},
  {id:'dragon', ic:'🐉', name:'Drachenfeuer', riddle:'Der Drache schläft im Logo.',
   h:['Im Hub gibt es etwas, das man oft antippt.','Tippe im Hub schnell mehrmals auf das Logo.','Hub-Logo 7× schnell antippen: der Drache erwacht und speit Feuer.']},
  {id:'shake', ic:'🫨', name:'Schütteln', riddle:'Manchmal hilft nur kräftiges Rütteln.',
   h:['Dein Handy kennt Bewegung.','Öffne einen Chat und bewege das Handy.','Im offenen Chat das Handy kräftig schütteln: die Blasen wackeln, „Hoppla!“. (Auf dem iPhone muss man die Bewegung beim ersten Mal erlauben.)']},
  {id:'words', ic:'🤫', name:'Geheimwörter', riddle:'Ein Schrägstrich öffnet eine Tür.',
   h:['Manche Wörter tun etwas, wenn man sie sendet.','Sende ein Wort mit „/“ davor. Denk an Himmel, Winter, Liebe oder ein Fabeltier.','/schnee, /stern, /herz und /drache lösen Effekte im Chat aus.']},
  {id:'owl', ic:'🦉', name:'Nachteule', riddle:'Wer spät wach ist, ist nicht allein.',
   h:['Die Uhrzeit spielt eine Rolle.','Zwischen Mitternacht und fünf Uhr morgens, und ihr beide müsst schreiben.','Nachts (0–5 Uhr, deine Uhr) schreiben beide innerhalb von 20 Minuten im selben Chat: „Zwei Nachteulen im Chat!“.']},
  {id:'stars', ic:'🌟', name:'Sternbild', riddle:'Vertrauen leuchtet.',
   h:['Im Hub zählt eine Kachel deine verifizierten Kontakte.','Tippe im Hub zweimal schnell auf die Kachel „Verifizierte“.','Doppeltipp auf die Hub-Kachel „✔ Verifizierte“: jeder verifizierte Kontakt ist ein Stern im Sternbild.']}
];
var LEVEL_NAMES = ['Kurz','Deutlich','Lösung'];
/* Ränge: ab min Eiern. Das Profilbild bekommt ab 3 ein Ei-Abzeichen. */
var RANKS = [
  {min:0, name:'Leeres Nest', ic:'🪺', note:'Noch kein Ei gefunden.', badge:'none'},
  {min:1, name:'Ei-Sucher',   ic:'🥚', note:'Du bist auf der Spur. Kein Abzeichen.', badge:'ring'},
  {min:3, name:'Eier-Lotse',  ic:'🥚', note:'Gesprungenes Ei am Profilbild. Du kannst anderen helfen.', badge:'crack'},
  {min:5, name:'Lotse Profi', ic:'🐣', note:'Schlüpfendes Küken am Profilbild.', badge:'chick'},
  {min:7, name:'Goldener Lotse', ic:'🐉', note:'Goldenes Drachenei, alle Eier gefunden. Eine Ehre, keine Belohnung.', badge:'gold'}
];
