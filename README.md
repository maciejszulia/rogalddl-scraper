# rogalddl-scraper

Lokalny, audytowalny katalog **publicznej i indeksowanej** muzyki Rogala DDL z YouTube. Program zapisuje metadane, URL-e, provenance, decyzje deduplikacyjne i opcjonalne fingerprinty; nie tworzy biblioteki pobranych plików audio. Główna playlista jest przeznaczona dla MPV.

> Zakres jest celowo uczciwy: scraper nie znajdzie materiałów prywatnych, usuniętych, niepublicznych, regionalnie niedostępnych ani niewidocznych dla wyszukiwarki. `summary.json` mierzy rezultat bieżącego skanu, nie całą istniejącą twórczość.

## Szybki start — skopiuj i wklej

```bash
cd /home/ms/rogalddl-scraper

./install.sh
~/.local/bin/rogalddl doctor

~/.local/bin/rogalddl scan \
  --query-budget 2 \
  --result-limit 3 \
  --no-second-pass \
  --fingerprint-mode metadata-only

~/.local/bin/rogalddl play --no-loop
```

To wykonuje mały, bezpieczny skan metadanych i odtwarza znalezione utwory przez MPV. Kolejne przyrostowe skanowanie połączone z odtwarzaniem:

```bash
~/.local/bin/rogalddl update-play --shuffle --no-loop
```

Wyniki są zapisywane w `${XDG_DATA_HOME:-$HOME/.local/share}/rogalddl/`. Jeśli `~/.local/bin` znajduje się w `PATH`, zamiast pełnej ścieżki można używać krótkiego polecenia `rogalddl`.

## Wymagania

- Node.js 22+ (ESM),
- `yt-dlp`,
- `mpv` do odtwarzania,
- opcjonalnie `fpcalc` (Chromaprint) i `ffmpeg` do fingerprintów.

Artix/Arch:

```bash
sudo pacman -S --needed nodejs npm yt-dlp mpv ffmpeg chromaprint
```

Projekt nie instaluje usługi i nie wymaga `systemd` ani `systemctl`.

## Instalacja

Bez zależności npm — kod korzysta ze standard library Node.js:

```bash
./test-all.sh
./install.sh
~/.local/bin/rogalddl doctor
```

`install.sh` kopiuje kod do `~/.local/lib/rogalddl` i atomowo podmienia launcher `~/.local/bin/rogalddl`. Alternatywnie uruchamiaj bez instalacji: `node ./rogalddl.mjs ...`.

## Pierwszy bezpieczny skan

Najpierw ograniczony metadata-only smoke test:

```bash
rogalddl scan --query-budget 2 --result-limit 3 --no-second-pass --fingerprint-mode metadata-only
rogalddl play --no-loop
```

Po weryfikacji `summary.json`, `review.json` i `rejected.json`:

```bash
rogalddl scan
rogalddl play --shuffle
```

Aktualizacja korzystająca z cache i punktów wznowienia:

```bash
rogalddl update
rogalddl update-play --shuffle --no-loop
```

`update` jest przyrostowe: rekordy z poprzedniej generacji, które wypadły poza ograniczony bieżący snapshot źródła, pozostają w katalogu z provenance `stale: true`. Pełny `scan` może przebudować katalog, ale przy częściowej awarii również zachowuje brakujące rekordy poprzedniej generacji. Każda opublikowana generacja częściowa — niezależnie od tego, czy zawiódł discovery, enrichment czy fingerprinting — ma status `partial`, a CLI zwraca kod `2`; brak jakiegokolwiek użytecznego wyniku nie zastępuje poprawnego katalogu.

## Discovery

Pierwsza tura obejmuje:

- oficjalny kanał po trwałym ID `UCp2d6_I25e30nk7Eb4ri2Ng`,
- Topic/YouTube Music `UCXu4ORG2S5VTmppGmKbzntw`,
- dokładne `"Rogal DDL"`,
- warianty: remix, bootleg, mashup, edit, rework, instrumental, acapella, live, freestyle, slowed, sped-up, feat/ft/prod.

Druga tura generuje deduplikowane zapytania z wykrytych tytułów, featuringów i producentów. Używany jest wspierany prefiks `ytsearchN:` — nigdy `ytsearchdate`. Każde źródło ma limit wyników, cały skan ma budżet zapytań, cache TTL, ograniczoną współbieżność i checkpointy. Klucz cache oraz sygnatura checkpointu obejmują locator, fazę i limity, więc zmiana parametrów nie odtwarza niekompletnego wyniku starszego przebiegu. Po rozpoczęciu drugiej tury jej ustalona kolejka również trafia do checkpointu; resume kontynuuje ją zamiast tworzyć nowe odgałęzienia z wyników fazy 2. Błąd jednego źródła jest raportowany, ale nie zatrzymuje pozostałych.

Najważniejsze limity:

```text
--query-budget N
--result-limit N
--second-pass-limit N
--second-pass-results N
--enrichment-limit N
--fingerprint-max-bytes N
--concurrency N
--timeout-ms N
--retries N
--no-second-pass
--no-cache
```

## Klasyfikacja i zachowanie danych

Każdy wynik zostaje zachowany w `raw.json`, a następnie trafia do jednej z klas:

- główny utwór,
- alternate version (np. remix/live/instrumental/slowed/acoustic/demo/remaster/cover),
- long-form (album, miks, pełny koncert),
- odrzucony teaser/Short/spoken-content/false match,
- niepewny przypadek do ręcznego przeglądu.

Long-form nie trafia domyślnie do głównej listy. Ograniczone przez `enrichmentLimit` wzbogacanie pobiera pełne metadane wyłącznie wybranych materiałów long-form. Wiarygodne rozdziały są mapowane do istniejących singli. Brakujący rozdział może zostać zapisany jako ograniczony czasowo adres MPV EDL w playliście. Materiał bez danych wystarczających do bezpiecznej segmentacji pozostaje zachowany i jest jawnie oznaczony `unsegmented`. `--enrichment-limit 0` wyłącza ten etap.

## Konserwatywna deduplikacja

Warstwy:

1. identyczne YouTube ID (agregacja provenance),
2. ręczne override'y,
3. zgodny jawny wariant,
4. podobieństwo tytułu/wykonawcy i tolerancja długości jako generator kandydatów,
5. Chromaprint jako dowód scalenia kandydatów,
6. opcjonalne fingerprinty początku/środka/końca.

Podobny tytuł **nie wystarcza do scalenia**. Bez fingerprintu kandydat pozostaje w katalogu i trafia do `review.json`. Remix, bootleg, mashup, edit, rework, live, freestyle, instrumental, acapella, slowed, sped-up, acoustic, demo, remaster, cover, karaoke, unplugged, extended i reverb są rozdzielane przed porównaniem audio.

Dla potwierdzonego duplikatu preferowany jest oficjalny kanał artysty, następnie Topic, kanał wydawcy/producenta/współpracownika, kompletność metadanych i jakość formatu. Wyświetlenia są tylko słabym tie-breakerem. `duplicates.json` zapisuje winnera, kopie, metodę, score, próg, cechy i provenance.

### Ręczne override'y

Przy pierwszym uruchomieniu powstaje:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/rogalddl/overrides.json
```

Format pokazuje `overrides.example.json`:

- `keep`: pary, których nigdy nie scalać,
- `merge`: ręcznie potwierdzony winner i kopie,
- `reject`: ręcznie potwierdzone błędne dopasowanie.

Plik ma `schemaVersion: 1`, jest jawny i nadaje się do wersjonowania. `keep`, `merge` i `reject` muszą być tablicami o udokumentowanym kształcie; wszystkie identyfikatory oraz podane jawnie powody muszą być niepustymi stringami i nigdy nie są automatycznie konwertowane z innych typów. Nieznane pola, konflikty oraz błędna semantyka powodują przerwanie przed skanem zamiast cichego pominięcia decyzji. Nie wpisuj do niego cookies ani tokenów.

## Tryby fingerprintów

```text
--fingerprint-mode metadata-only   bez pobierania próbek
--fingerprint-mode candidates      domyślnie; tylko kandydaci na duplikaty
--fingerprint-mode fingerprint-all wszystkie utwory
--fingerprint-mode segments        pełny fingerprint + początek/środek/koniec
```

Próbki trafiają wyłącznie do prywatnego katalogu tymczasowego, a blok `finally` usuwa go po sukcesie i błędzie. Każde pobranie ma twardy limit `fingerprintMaxBytes` (domyślnie 64 MiB), weryfikowany także po pobraniu. Wpis cache jest używany tylko wtedy, gdy jego `sourceSignature` odpowiada aktualnemu ID, URL-owi i długości źródła; niezgodny wpis jest usuwany przed deduplikacją. Tryb `segments` i jawne `--refresh-fingerprints` obejmują także aktywne rekordy przeniesione z poprzedniej generacji. Program nie zachowuje audio w katalogu danych. Brak `fpcalc` nie blokuje metadata-only; kandydaci pozostają w `review.json`, a `fingerprints.json` oraz `summary.json` zapisują jawny status capability zamiast udawać, że fingerprinting został wykonany.

## MPV

```bash
rogalddl play                         # audio-only, loop domyślnie
rogalddl play --shuffle --no-loop
rogalddl play --video
rogalddl play --variant remix,live
rogalddl play --pick
rogalddl play --ipc-socket /tmp/mpv-rogalddl.sock
rogalddl reload --ipc-socket /tmp/mpv-rogalddl.sock
```

MPV jest uruchamiany przez `spawn()` z tablicą argumentów i `shell: false`. Jego stdout/stderr przechodzi przez ograniczony bufor linii oraz redakcję sekretów przed pokazaniem w terminalu. Metadane YouTube nie są wykonywane jako kod. Picker filtruje zapisany katalog lokalnie, a IPC dopuszcza tylko ograniczony zestaw komend (`loadlist`, bezpieczne odczyty właściwości i pause).

## Ścieżki XDG

```text
data:   ${XDG_DATA_HOME:-$HOME/.local/share}/rogalddl
config: ${XDG_CONFIG_HOME:-$HOME/.config}/rogalddl
cache:  ${XDG_CACHE_HOME:-$HOME/.cache}/rogalddl
```

W katalogu danych powstają atomowo:

- `playlist.m3u8`,
- `catalog.json`,
- `duplicates.json`,
- `review.json`,
- `long-form.json`,
- `rejected.json`,
- `fingerprints.json`,
- `summary.json`,
- `raw.json` (oczyszczone wyniki discovery bez podpisanych URL-i formatów, nagłówków i pól uwierzytelniających).

Każdy JSON ma `schemaVersion`. Rekordy i raporty są stabilnie sortowane. Nowy komplet powstaje w katalogu staging; pliki i katalog są synchronizowane na dysk przed podmianą. Lock przy katalogu danych odrzuca równoległego writera. Bezpośrednio przed commit pointem publikacja ponownie sprawdza sygnał abort. Przy następnym starcie program odzyskuje poprzednią generację po przerwaniu pomiędzy rename'ami i usuwa porzucony staging. Nieudany lub przerwany skan pozostawia ostatni opublikowany katalog bez zmian. Katalogi konfiguracji i cache są wymuszane jako prywatne (`0700`), a pliki konfiguracji jako `0600`; symlink lub obcy właściciel jest odrzucany. Uszkodzony JSON oraz nieznane klucze konfiguracji nie są zastępowane ani ignorowane po cichu.

## Prywatność i diagnostyka

- brak automatycznego kopiowania lub logowania cookies,
- usuwanie pól `cookie`, `token`, `Authorization`, `http_headers`, kluczy API i sekretów z artefaktów,
- redakcja typowych sekretów w błędach,
- brak DRM/access-control bypass,
- rozpoznawanie komunikatów yt-dlp o JS runtime, PO tokenie, cookies/loginie, rate limit i niedostępności,
- timeout, retry z exponential backoff i jitterem, zabijanie całej grupy procesów po timeout/abort oraz bezpieczna reakcja na SIGINT/SIGTERM/SIGPIPE.

`doctor` pokazuje wykryte narzędzia i ścieżki, ale nie wypisuje credentials:

```bash
rogalddl doctor
```

## Testy offline

```bash
./test-all.sh
```

Fixture'y i mocki sprawdzają m.in. exact-ID, potwierdzony ten sam master, zachowanie odmiennych wersji, review zamiast agresywnego merge, long-form, częściowe awarie wszystkich etapów, atomowość, redakcję sekretów, bezpieczne argumenty MPV, deterministyczność i pełny zestaw artefaktów. Offline E2E uruchamia realny entrypoint dla `scan`, `update`, `play` i `update-play`, sprawdza częściowy kod wyjścia oraz instalator z `PREFIX` zawierającym spacje. Testy nie wymagają sieci.

## Ograniczenia

Heurystyczna klasyfikacja może wymagać override'u. Flat metadata z YouTube bywa niepełne. Chromaprint porównuje nagranie, ale nie rozstrzyga autorstwa ani praw. EDL rozdziałów zależy od obsługi `ytdl://` w zainstalowanym MPV/yt-dlp. YouTube może zmienić ekstraktor, ograniczyć ruch, wymagać aktualnego JS runtime/PO tokenu lub odmówić anonimowego dostępu; program raportuje te sytuacje i ich nie obchodzi.
