### Operation: Secret Rendezvous
**Ein privates Abenteuer. Geheime Orte. Niemand sieht, wo du wirklich bist.**

Stell dir vor: Deine engste Freundesgruppe will sich treffen — aber nicht einfach in irgendeinem Restaurant. Eine echte Schnitzeljagd durch die Stadt, die an einem geheimen, exklusiven Ort endet. Einer versteckten Rooftop-Bar. Einem privaten Lagerfeuer im Wald.

Das Problem mit normalen GPS-Apps: Sie zeigen jeden Schritt. Jede Bewegung. Jeden Standort — auch dem Server, auch der Öffentlichkeit.

**SpotME Caching macht das anders.** Hier ist, wie das Abenteuer abläuft.

![image-310~2](_res/image-310~2.jpg)

---

#### 1 · Einwahl ohne Spuren

Jeder aus der Gruppe loggt sich über einen einzigartigen Code (`sm_code`) und ein Auth-Token (`sm_token`) ein — gespeichert lokal auf dem eigenen Gerät, nicht in einer zentralen Nutzerdatenbank mit E-Mail oder Passwort. Kein Account-Zwang, kein Social Login. Eure Profildaten liegen serverseitig **AES-256-CBC-verschlüsselt** — selbst bei direktem Datenbankzugriff bleibt das unlesbar.

#### 2 · Die unsichtbare Jagd

Alle schwärmen aus, um Caches oder den Wochen-Spot zu finden.

— **Dein Standort bleibt bei dir.** Dein echter GPS-Standort wird nie an den Server übertragen. Andere sehen nur dich selbst auf deiner eigenen Karte.

— **Nur ein Online-Punkt.** Deine Freunde sehen lediglich ein dezentes ● — "ich bin aktiv, ich bin auf der Jagd". Mehr Information existiert serverseitig schlicht nicht, also kann sie auch niemand abgreifen.

#### 3 · Absprachen, die verschwinden

Tipps austauschen, Pläne schmieden — der integrierte Chat läuft über direkte Peer-Verbindungen zwischen euren Geräten. Der Server vermittelt nur die Verbindung, er liest und speichert die Nachrichten nicht. App schließen oder Verlauf löschen — und die Konversation ist weg. Wie ein Funkspruch, der nie aufgezeichnet wurde.

#### 4 · Das Finale: Live Spot

Der Erste erreicht das Ziel. Jetzt wird's spannend:

— **Spot-Aktivierung.** Über den Floating Action Button (📍) setzt der Finder einen "Live Spot" — mit Emoji, Foto, fertig.

— **Der grüne Puls.** Sekunden später leuchtet bei allen anderen das `liveBadge` auf. Sofort klar: Der Treffpunkt ist live.

— **Verifizierter Check-in.** Erst bei den exakten GPS-Koordinaten — geprüft im 50m-Radius — schaltet die App den Check-in frei. Erfolg bestätigt, Match-Screen erscheint.

---

### Fazit

Kein Bewegungsprofil. Keine Server-Logs eurer Chats. Keine Standortdaten, die irgendwo herumliegen, die jemand später auswerten könnte. **SpotME Caching** macht aus einem Treffen ein echtes Abenteuer — gebaut auf einem einzigen Prinzip: Was niemand speichert, kann niemand sehen.

