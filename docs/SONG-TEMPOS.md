# Mutopia song default tempos

The Mutopia MIDI files are mechanical LilyPond renderings; many sit at a flat default tempo (often 60 BPM) and play far too slow or fast. `renderer/songs-mutopia.js` therefore carries a per-piece `tempoScale` (multiplier on the file tempo; below 1 = slower) applied when the song is opened, so duration, bars, falling-note speed, scoring and the speed buttons all behave normally. Targets are typical performance lengths (estimates from musical knowledge, kept a little slow for the hard pieces; Wait mode and 0.5x/0.75x speed still apply). Pieces whose file tempo already lands near a typical performance are left at 1. "uncertain" = unsure, left unscaled. "long" = may exceed 12 min.

Summary: 24 scaled, 19 left alone, 14 uncertain (left alone).

| Title (id) | file tempo BPM | target length | scale | resulting duration | notes/s | notes |
|---|---|---|---|---|---|---|
| Revolutionary Étude (chopin-etude-op10-12) | 160 | 2:30 | 0.84 | 2:29 | 14.0 | Presto con fuoco; slightly under the usual ~2:30 so the left-hand run is learnable |
| Étude Op. 10 No. 1 (chopin-etude-op10-1) | 176 | 2:05 | 0.86 | 2:05 | 10.7 | Allegro; typical ~2:00-2:15, kept a touch slower |
| Black Key Étude (chopin-etude-op10-5) | 116 | - | 1 | 1:30 | 18.1 | file tempo is already close to a typical performance |
| Étude Op. 10 No. 2 (chopin-etude-op10-2) | 144 | - | 1 | 1:22 | 17.9 | file tempo is already close to a typical performance |
| Étude Op. 10 No. 9 (chopin-etude-op10-9) | 144 | - | 1 | 1:23 | 14.8 | uncertain; unsure of a typical length against this file; left unscaled |
| Aeolian Harp Étude (chopin-etude-op25-1) | 104 | - | 1 | 1:54 | 19.5 | uncertain; unsure of a typical length against this file; left unscaled |
| Étude Op. 25 No. 2 (chopin-etude-op25-2) | 224 | - | 1 | 1:19 | 15.2 | file tempo is already close to a typical performance |
| Ballade No. 4 (chopin-ballade-4) | 60 | 10:20 | 1.16 | 10:18 | 9.8 | Andante con moto 6/8; file runs near 12 min at a flat 60 |
| Ballade No. 1 (chopin-ballade-1) | 65 | 10:00 | 1.16 | 9:59 | 8.4 | file tempo map is too slow overall; typical 9-10 min |
| Fantaisie-Impromptu (chopin-fantaisie-impromptu) | 168 | 5:00 | 0.85 | 4:58 | 10.1 | typical ~5:00 with the slow middle section |
| Ballade No. 2 in B minor (liszt-ballade-2) | 60 | 14:00 | 1.66 | 14:00 | 8.3 | long; ~14 min is typical (file: ~23 min); flagged long |
| Étude Op. 2 No. 1 (scriabin-etude-op2-1) | 60 | - | 1 | 2:15 | 8.3 | uncertain; unsure of a typical length against this file; left unscaled |
| Appassionata, 3rd mvt. (beethoven-appassionata-3) | 134 | - | 1 | 8:16 | 14.6 | uncertain; unsure of a typical length against this file; left unscaled |
| Sonata No. 32, 1st mvt. (beethoven-sonata-32-1) | 52 | - | 1 | 7:17 | 12.2 | uncertain; unsure of a typical length against this file; left unscaled |
| Tempest, 1st mvt. (beethoven-tempest-1) | 40 | - | 1 | 6:13 | 7.7 | file tempo is already close to a typical performance |
| Pathétique, 1st mvt. (beethoven-pathetique-1) | 33 | - | 1 | 6:15 | 11.4 | uncertain; unsure of a typical length against this file; left unscaled |
| Sonata No. 2, Finale (chopin-sonata-2-finale) | 224 | - | 1 | 1:22 | 21.9 | file tempo is already close to a typical performance |
| Raindrop Prelude (chopin-raindrop) | 80 | 6:00 | 0.74 | 6:01 | 4.2 | Sostenuto, ~6:00 |
| Minute Waltz (chopin-minute-waltz) | 280 | 1:50 | 0.82 | 1:49 | 12.5 | file is at the fast end (quarter 280); ~1:50 is learner-friendly |
| Waltz in B minor (chopin-waltz-op69-2) | 152 | - | 1 | 2:52 | 9.3 | file tempo is already close to a typical performance |
| Nocturne Op. 9 No. 2 (chopin-nocturne-op9-2) | 66 | 4:15 | 0.79 | 4:16 | 4.9 | Andante, ~4:15-4:30 typical |
| Arabesque No. 1 (debussy-arabesque-1) | 144 | - | 1 | 2:56 | 8.2 | uncertain; unsure of a typical length against this file; left unscaled |
| Clair de Lune (debussy-clair-de-lune) | 60 | 5:00 | 1.08 | 4:59 | 4.9 | ~5:00 |
| Prelude in C-sharp minor (rachmaninoff-prelude-c-sharp-minor) | 60 | 3:20 | 0.82 | 3:20 | 8.6 | Lento/Agitato; typical ~3:20 |
| Prelude Op. 23 No. 5 (rachmaninoff-prelude-op23-5) | 108 | - | 1 | 3:47 | 17.0 | file tempo is already close to a typical performance |
| Prelude Op. 23 No. 2 (rachmaninoff-prelude-op23-2) | 80 | - | 1 | 3:05 | 17.1 | uncertain; unsure of a typical length against this file; left unscaled |
| Rondo alla Turca (mozart-rondo-alla-turca) | 60 | 3:00 | 1.42 | 2:60 | 9.0 | Allegretto, ~3:00 (file: flat 60) |
| Fantasia in D minor (mozart-fantasia-d-minor) | 80 | - | 1 | 4:43 | 5.3 | uncertain; unsure of a typical length against this file; left unscaled |
| Sonata in C minor, 1st mvt. (mozart-sonata-457-1) | 168 | - | 1 | 4:24 | 8.2 | file tempo is already close to a typical performance |
| Sonata Facile, 1st mvt. (mozart-sonata-facile-1) | 132 | - | 1 | 2:12 | 9.7 | uncertain; unsure of a typical length against this file; left unscaled |
| Für Elise (full) (beethoven-fur-elise-full) | 72 | 2:50 | 0.77 | 2:49 | 5.3 | Poco moto, full bagatelle ~3:00; slightly slower |
| Impromptu Op. 90 No. 1 (schubert-impromptu-90-1) | 44 | - | 1 | 9:28 | 8.8 | file tempo is already close to a typical performance |
| Impromptu Op. 90 No. 2 (schubert-impromptu-90-2) | 160 | - | 1 | 5:19 | 9.9 | uncertain; unsure of a typical length against this file; left unscaled |
| Impromptu Op. 90 No. 4 (schubert-impromptu-90-4) | 130 | - | 1 | 7:35 | 12.8 | file tempo is already close to a typical performance |
| Impromptu Op. 142 No. 1 (schubert-impromptu-142-1) | 110 | - | 1 | 9:07 | 11.5 | file tempo is already close to a typical performance |
| Impromptu Op. 142 No. 2 (schubert-impromptu-142-2) | 100 | - | 1 | 7:13 | 6.3 | file tempo is already close to a typical performance |
| Moment Musical No. 3 (schubert-moment-musical-3) | 80 | - | 1 | 1:57 | 9.1 | file tempo is already close to a typical performance |
| Träumerei (schumann-traumerei) | 60 | 2:30 | 0.74 | 2:30 | 2.3 | typical ~2:30 (file ritards are mechanical) |
| Intermezzo Op. 118 No. 2 (brahms-intermezzo-118-2) | 80 | 5:20 | 0.87 | 5:21 | 5.2 | Andante teneramente, ~5:00-6:00 |
| Waltz Op. 39 No. 10 (brahms-waltz-39-10) | 160 | - | 1 | 0:36 | 12.7 | uncertain; unsure of a typical length against this file; left unscaled |
| In the Hall of the Mountain King (grieg-mountain-king) | 138 | - | 1 | 2:25 | 10.0 | file tempo is already close to a typical performance |
| Wedding Day at Troldhaugen (grieg-troldhaugen) | 120 | - | 1 | 6:06 | 10.5 | file tempo is already close to a typical performance |
| March of the Dwarfs (grieg-troldtog) | 120 | - | 1 | 3:13 | 11.3 | file tempo is already close to a typical performance |
| Dumka (tchaikovsky-dumka) | 60 | - | 1 | 9:33 | 7.5 | uncertain; unsure of a typical length against this file; left unscaled |
| Scherzo in E minor (mendelssohn-scherzo-e-minor) | 60 | 4:30 | 1.59 | 4:30 | 7.8 | uncertain; Presto/leggiero scherzo; file flat 60 gives 7 min; estimate |
| Maple Leaf Rag (joplin-maple-leaf-rag) | 120 | 3:00 | 0.8 | 3:00 | 14.3 | with repeats ~3:00; Joplin: "never play fast" |
| The Entertainer (joplin-the-entertainer) | 72 | - | 1 | 4:13 | 10.4 | file tempo is already close to a typical performance |
| Prelude in C (BWV 846) (bach-prelude-c-bwv846) | 60 | - | 1 | 2:20 | 3.9 | file tempo is already close to a typical performance |
| Toccata in F-sharp minor (bach-toccata-bwv910) | 60 | 10:00 | 1.31 | 10:00 | 6.9 | ~10 min typical; file 13 min at flat 60 |
| Invention No. 13 (bach-invention-13) | 100 | - | 1 | 1:00 | 9.4 | uncertain; unsure of a typical length against this file; left unscaled |
| Consolation No. 3 (liszt-consolation-3) | 60 | 5:00 | 0.81 | 5:00 | 3.4 | Lento placido ~5:00 |
| Consolation No. 1 (liszt-consolation-1) | 60 | 2:30 | 0.66 | 2:30 | 1.8 | Andante con moto ~2:30 |
| Consolation No. 4 (liszt-consolation-4) | 60 | 3:10 | 0.73 | 3:09 | 2.7 | Quasi adagio ~3:10 |
| Pineapple Rag (joplin-pineapple-rag) | 100 | 3:20 | 0.89 | 3:19 | 12.5 | ~3:20 typical |
| Elite Syncopations (joplin-elite-syncopations) | 60 | 3:20 | 1.48 | 3:20 | 11.2 | ~3:15 typical (file flat 60) |
| A Breeze from Alabama (joplin-breeze-from-alabama) | 82 | - | 1 | 4:12 | 11.7 | file tempo is already close to a typical performance |
| Magnetic Rag (joplin-magnetic-rag) | 60 | 4:50 | 2.62 | 4:50 | 10.4 | ~4:45 typical (file flat 60 = 12.7 min) |

## Added with the library growth (78 pieces)

Same method as above. Pieces whose file duration already sits between 25 s and 12 min with a plausible tempo are left at 1; only the ones marked with a scale were adjusted.

| Title (id) | file tempo BPM | target length | scale | resulting duration | notes/s | notes |
|---|---|---|---|---|---|---|
| Menuet, BWV Anh. 113 (bach-menuet-anh113) | 120 | - | 1 | 0:48 | 5.4 | file tempo is already close to a typical performance |
| Menuet in G, BWV Anh. 114 (bach-menuet-anh114) | 140 | - | 1 | 0:41 | 5.0 | file tempo is already close to a typical performance |
| Menuet, BWV Anh. 116 (bach-menuet-anh116) | 125 | - | 1 | 0:58 | 5.4 | file tempo is already close to a typical performance |
| Minuet in B-flat, BWV Anh. 118 (bach-minuet-anh118) | 60 | - | 1 | 1:18 | 2.9 | file tempo is already close to a typical performance |
| Minuet in C minor, BWV Anh. 121 (bach-minuet-anh121) | 108 | - | 1 | 0:40 | 3.7 | file tempo is already close to a typical performance |
| Polonaise in F, BWV Anh. 117a (bach-polonaise-anh117a) | 60 | - | 1 | 0:48 | 4.9 | file tempo is already close to a typical performance |
| Invention No. 4 (bach-invention-4) | 90 | - | 1 | 0:52 | 8.5 | file tempo is already close to a typical performance |
| Invention No. 8 (bach-invention-8) | 90 | - | 1 | 1:07 | 9.0 | file tempo is already close to a typical performance |
| Little Prelude, BWV 928 (bach-little-prelude-928) | 69 | - | 1 | 1:23 | 7.9 | file tempo is already close to a typical performance |
| Prelude in C-sharp minor (WTC I) (bach-wtc1-prelude-4) | 108 | 2:42 | 0.8 | 2:42 | 5.1 | Andante-ish; typical ~2:40, kept a little slow |
| Bourrée I (English Suite No. 1) (bach-english-suite-1-bourree) | 184 | - | 1 | 1:05 | 8.8 | file tempo is already close to a typical performance |
| Sonata No. 20, 1st mvt. (beethoven-sonata-20-1) | 142 | - | 1 | 3:25 | 7.9 | file tempo is already close to a typical performance |
| Sonata No. 20, Tempo di Menuetto (beethoven-sonata-20-2) | 134 | - | 1 | 2:41 | 8.0 | file tempo is already close to a typical performance |
| Sonata No. 19, 1st mvt. (beethoven-sonata-19-1) | 98 | - | 1 | 2:14 | 9.5 | uncertain; unsure of a typical length against this file; left unscaled |
| Sonata No. 19, Rondo (beethoven-sonata-19-2) | 124 | - | 1 | 3:58 | 8.4 | file tempo is already close to a typical performance |
| Sonata No. 25, Andante (beethoven-sonata-25-2) | 72 | - | 1 | 2:06 | 6.4 | file tempo is already close to a typical performance |
| Pathétique, 2nd mvt. (beethoven-pathetique-2) | 36 | - | 1 | 4:03 | 6.7 | file tempo is already close to a typical performance |
| Menuett, WoO 82 (beethoven-menuett-woo82) | 112 | - | 1 | 3:16 | 5.9 | uncertain; unsure of a typical length against this file; left unscaled |
| Sonata K. 331, Menuetto (mozart-sonata-331-menuetto) | 134 | 4:26 | 1.25 | 4:26 | 8.0 | Menuetto with trio, ~4:25 typical (file 5:33) |
| Sonata K. 331, Theme (mozart-sonata-331-theme) | 56 | - | 1 | 1:55 | 4.2 | file tempo is already close to a typical performance |
| Sonata Facile, 2nd mvt. (mozart-sonata-facile-2) | 60 | - | 1 | 3:41 | 6.0 | file tempo is already close to a typical performance |
| Sonata Facile, 3rd mvt. (mozart-sonata-facile-3) | 104 | - | 1 | 1:24 | 10.4 | uncertain; unsure of a typical length against this file; left unscaled |
| Gigue, K. 574 (mozart-gigue-574) | 140 | - | 1 | 0:49 | 9.4 | file tempo is already close to a typical performance |
| Marche funèbre, K. 453a (mozart-marche-funebre-453a) | 60 | - | 1 | 1:03 | 4.2 | file tempo is already close to a typical performance |
| Menuetto (Sonata Hob. XVI:27) (haydn-menuetto-27) | 92 | - | 1 | 2:09 | 5.0 | file tempo is already close to a typical performance |
| Menuetto (Sonata Hob. XVI:28) (haydn-menuetto-28) | 60 | - | 1 | 2:24 | 3.0 | file tempo is already close to a typical performance |
| Sonatina Op. 20 No. 1, Allegro (kuhlau-sonatina-20-1-1) | 120 | - | 1 | 2:39 | 6.7 | file tempo is already close to a typical performance |
| Sonatina Op. 20 No. 1, Andante (kuhlau-sonatina-20-1-2) | 72 | - | 1 | 0:40 | 6.8 | file tempo is already close to a typical performance |
| Menuet (handel-menuet-161) | 84 | - | 1 | 0:60 | 4.7 | file tempo is already close to a typical performance |
| Gavotte (handel-gavotte-151) | 92 | - | 1 | 0:52 | 4.6 | file tempo is already close to a typical performance |
| Sonatina, HWV 585 (handel-sonatina-hwv585) | 120 | - | 1 | 0:38 | 6.1 | file tempo is already close to a typical performance |
| Allemande (handel-allemande-166) | 72 | - | 1 | 0:60 | 6.6 | file tempo is already close to a typical performance |
| Sonata K. 11 (scarlatti-sonata-k11) | 120 | - | 1 | 0:58 | 9.6 | uncertain; unsure of a typical length against this file; left unscaled |
| Sonata in C (scarlatti-sonata-in-c) | 120 | - | 1 | 2:18 | 5.8 | file tempo is already close to a typical performance |
| Kinderszenen: Of Foreign Lands (schumann-kinderszenen-1) | 72 | - | 1 | 0:37 | 6.1 | uncertain; unsure of a typical length against this file; left unscaled |
| Kinderszenen: Curious Story (schumann-kinderszenen-2) | 112 | - | 1 | 1:04 | 9.7 | file tempo is already close to a typical performance |
| Kinderszenen: Pleading Child (schumann-kinderszenen-4) | 60 | - | 1 | 0:33 | 6.7 | uncertain; unsure of a typical length against this file; left unscaled |
| Kinderszenen: Happy Enough (schumann-kinderszenen-5) | 84 | - | 1 | 0:35 | 11.6 | uncertain; unsure of a typical length against this file; left unscaled |
| Kinderszenen: An Important Event (schumann-kinderszenen-6) | 120 | - | 1 | 0:36 | 12.2 | uncertain; unsure of a typical length against this file; left unscaled |
| Album for the Young: Melody (schumann-album-melodie) | 60 | - | 1 | 1:36 | 3.2 | file tempo is already close to a typical performance |
| Album for the Young: The Merry Farmer (schumann-album-merry-farmer) | 100 | - | 1 | 0:48 | 7.3 | file tempo is already close to a typical performance |
| Prelude Op. 28 No. 4 (chopin-prelude-4) | 56 | - | 1 | 1:48 | 5.5 | file tempo is already close to a typical performance |
| Prelude Op. 28 No. 6 (chopin-prelude-6) | 45 | - | 1 | 1:41 | 4.0 | file tempo is already close to a typical performance |
| Prelude Op. 28 No. 7 (chopin-prelude-7) | 120 | 0:40 | 0.6 | 0:40 | 7.0 | file is 24 s; ~0:40 is typical for this Andantino |
| Prelude Op. 28 No. 20 (chopin-prelude-20) | 42 | - | 1 | 1:14 | 3.9 | file tempo is already close to a typical performance |
| Mazurka Op. 6 No. 1 (chopin-mazurka-6-1) | 60 | 2:49 | 1.3 | 2:49 | 4.0 | file sits at a flat 60; ~2:50 is typical with repeats |
| Prelude Op. 28 No. 1 (chopin-prelude-1) | 60 | - | 1 | 0:34 | 9.7 | file tempo is already close to a typical performance |
| Morning Prayer (Op. 39) (tchaikovsky-morning-prayer) | 62 | - | 1 | 1:10 | 3.5 | file tempo is already close to a typical performance |
| March of the Wooden Soldiers (Op. 39) (tchaikovsky-wooden-soldiers) | 140 | - | 1 | 0:40 | 7.9 | file tempo is already close to a typical performance |
| Old French Song (Op. 39) (tchaikovsky-old-french-song) | 70 | - | 1 | 0:55 | 3.4 | file tempo is already close to a typical performance |
| La Candeur (Op. 100) (burgmuller-la-candeur) | 152 | - | 1 | 0:36 | 6.6 | file tempo is already close to a typical performance |
| Innocence (Op. 100) (burgmuller-innocence) | 112 | - | 1 | 0:27 | 8.0 | file tempo is already close to a typical performance |
| Progrès (Op. 100) (burgmuller-progres) | 132 | - | 1 | 0:29 | 7.3 | file tempo is already close to a typical performance |
| La Gracieuse (Op. 100) (burgmuller-la-gracieuse) | 100 | - | 1 | 0:29 | 11.0 | file tempo is already close to a typical performance |
| La Chasse (Op. 100) (burgmuller-la-chasse) | 200 | - | 1 | 0:51 | 10.4 | file tempo is already close to a typical performance |
| Tendre Fleur (Op. 100) (burgmuller-tendre-fleur) | 152 | - | 1 | 0:37 | 7.2 | file tempo is already close to a typical performance |
| L'Adieu (Op. 100) (burgmuller-ladieu) | 184 | - | 1 | 0:53 | 11.3 | file tempo is already close to a typical performance |
| Douce Plainte (Op. 100) (burgmuller-douce-plainte) | 126 | - | 1 | 0:34 | 7.8 | file tempo is already close to a typical performance |
| Melodic Study Op. 840 No. 1 (czerny-op840-1) | 140 | - | 1 | 0:55 | 8.2 | file tempo is already close to a typical performance |
| Gymnopédie No. 1 (satie-gymnopedie-1) | 60 | 2:56 | 0.8 | 2:56 | 2.0 | Lent et douloureux; ~3:00 typical (file 2:21) |
| Gymnopédie No. 2 (satie-gymnopedie-2) | 60 | - | 1 | 3:15 | 1.9 | file tempo is already close to a typical performance |
| Gymnopédie No. 3 (satie-gymnopedie-3) | 60 | - | 1 | 3:00 | 1.8 | file tempo is already close to a typical performance |
| Gnossienne No. 1 (satie-gnossienne-1) | 100 | - | 1 | 3:17 | 4.2 | file tempo is already close to a typical performance |
| Gnossienne No. 2 (satie-gnossienne-2) | 60 | 2:46 | 1.2 | 2:46 | 1.9 | flat 60 in the file; ~2:45 typical |
| Gnossienne No. 3 (satie-gnossienne-3) | 40 | 3:22 | 1.6 | 3:22 | 1.9 | file at 40 BPM is 5:24; ~3:20 typical |
| Arabesque No. 2 (debussy-arabesque-2) | 120 | 2:36 | 1.4 | 2:36 | 8.3 | ~2:35 typical (file 3:38) |
| The Easy Winners (joplin-easy-winners) | 60 | 3:22 | 1.5 | 3:22 | 8.3 | file flat 60 = 5 min; ~3:20 typical with repeats |
| Peacherine Rag (joplin-peacherine-rag) | 80 | - | 1 | 2:13 | 10.7 | file tempo is already close to a typical performance |
| Solace (joplin-solace) | 72 | - | 1 | 4:06 | 8.8 | file tempo is already close to a typical performance |
| Sugar Cane (joplin-sugar-cane) | 100 | - | 1 | 2:53 | 15.1 | file tempo is already close to a typical performance |
| Hungarian Melody (schubert-hungarian-melody) | 76 | - | 1 | 2:43 | 8.9 | file tempo is already close to a typical performance |
| Impromptu Op. 90 No. 3 (schubert-impromptu-90-3) | 120 | - | 1 | 5:54 | 7.7 | file tempo is already close to a typical performance |
| Song Without Words Op. 85 No. 1 (mendelssohn-song-without-words-85-1) | 60 | - | 1 | 1:40 | 7.4 | file tempo is already close to a typical performance |
| Venetian Gondola Song Op. 19 No. 6 (mendelssohn-gondola-song-19-6) | 60 | - | 1 | 2:18 | 4.3 | uncertain; unsure of a typical length against this file; left unscaled |
| Lualåt (Mountaineer's Song) (grieg-lualat) | 120 | - | 1 | 2:30 | 3.5 | file tempo is already close to a typical performance |
| Åse's Death (grieg-ases-death) | 50 | - | 1 | 3:36 | 3.5 | file tempo is already close to a typical performance |
| Rumores de la Caleta (albeniz-rumores-de-la-caleta) | 60 | - | 1 | 4:22 | 5.5 | uncertain; unsure of a typical length against this file; left unscaled |
| Waltz Op. 39 No. 15 (brahms-waltz-39-15) | 116 | - | 1 | 1:08 | 10.6 | file tempo is already close to a typical performance |
