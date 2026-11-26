// German text detection for the translation tests. A rendered English page or a
// translated source file must not contain these words or an umlaut. The list
// holds frequent German UI words; each one is matched as a whole word.
export const guardWords=['Hilfe','Abmelden','Suchen','Geräte','Konto','Einstellungen','Darstellung','Schließen','ausblenden','einblenden','aktualisieren','Bereiche','Pfad','oder','Strg',
 'Abbrechen','Speichern','Verwerfen','Entfernen','Erstellen','Bearbeiten','Keine','Kein','nicht','und','der','die','das','ist','wird','mit','Bitte','Gruppe','Kunde','Kunden','Benutzer','Auftrag','Rolle','Rechte','Schritt','Schritte','Ergebnis','Anleitung','Wartung','Fehler','Erfolgreich','Fehlgeschlagen','Abgelaufen','Wartend','Geplant','Verbindung','Anmeldung','Passwort','Sitzung','Dienst','Dienste','Ereignisse','Dateien','Freigabe','Einstellung','Anfrage','Datei','Netzwerk','Netzwerkdiagnose','gemeldet','eingerichtet','GERAET'];

/** The guard words found in text, plus 'umlaut' for any ä, ö, ü or ß. */
export const germanIn=text=>{const found=guardWords.filter(word=>new RegExp(`(?<![\\p{L}])${word}(?![\\p{L}])`,'u').test(text));if(/[äöüÄÖÜß]/.test(text))found.push('umlaut');return found;};

/** Rendered markup without attributes that hold ids, classes or links, so only visible text and ARIA remain. */
export const visible=html=>html.replace(/\s(?:class|id|href|for|aria-controls|aria-labelledby|aria-describedby|data-[\w-]+)="[^"]*"/g,'');
