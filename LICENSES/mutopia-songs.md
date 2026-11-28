# Mutopia Project songs

Keylight bundles 135 piano and keyboard pieces as MIDI files from the [Mutopia Project](https://www.mutopiaproject.org)
(also served at https://sca.uwaterloo.ca/Mutopia/), in `renderer/songs/mutopia/` and `renderer/songs/mutopia-sa/`.
They are registered in `renderer/songs-mutopia.js`, and the app shows each piece's credit under the song title.

- **The compositions** are in the public domain (composers died in 1955 or earlier, source editions published before 1929).
- **Each MIDI file** is generated from a LilyPond file written by a Mutopia volunteer (the typesetter) and carries the
  licence that typesetter chose for that piece: Public Domain, CC BY or CC BY-SA. The licence is listed per piece below
  and on each source page (see the Mutopia legal page, https://sca.uwaterloo.ca/Mutopia/legal.html).
- **Public Domain** files need no credit; Keylight gives one anyway.
- **CC BY** files (8) are credited to their typesetter, with the licence, wherever the song is shown.
  Licence: https://creativecommons.org/licenses/by/3.0/ (all CC BY pieces are 3.0)
- **CC BY-SA** files (15) are kept apart in `renderer/songs/mutopia-sa/`. They are separate, attributed data files
  that the app loads at run time. Their own CC BY-SA licences apply independently of the app licence:
  anyone who redistributes or adapts those files must keep the attribution and share the result under the same
  CC BY-SA licence. Licences: https://creativecommons.org/licenses/by-sa/2.5/, https://creativecommons.org/licenses/by-sa/3.0/ and https://creativecommons.org/licenses/by-sa/4.0/
- The files are provided as-is, with no warranty, and no claim that they match the printed editions.
- Files are unmodified Mutopia downloads (only renamed to `mutopia-<piece id>-<name>.mid`).

`scripts/test-song-licences.js` checks that every piece listed in `renderer/songs-mutopia.js` has a licence, a typesetter
credit, a source page and a file, that CC BY-SA pieces are only in `mutopia-sa/`, and that each one is listed in the tables below.

## Public Domain (112)

| Title | Composer | Licence | Typesetter / contributor | Source page | Mutopia | File (under `renderer/songs/`) |
|---|---|---|---|---|---|---|
| Revolutionary Étude | F. F. Chopin | Public Domain | Roland Goretzki | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=743 | Mutopia piece 743 | `mutopia/mutopia-743-op-10-12-wfi.mid` |
| Étude Op. 10 No. 1 | F. F. Chopin | Public Domain | Roland Goretzki | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=914 | Mutopia piece 914 | `mutopia/mutopia-914-chp-10-01.mid` |
| Black Key Étude | F. F. Chopin | Public Domain | Roland Goretzki | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=926 | Mutopia piece 926 | `mutopia/mutopia-926-chp-10-05.mid` |
| Étude Op. 10 No. 2 | F. F. Chopin | Public Domain | Roland Goretzki | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=508 | Mutopia piece 508 | `mutopia/mutopia-508-10-02-i.mid` |
| Étude Op. 10 No. 9 | F. F. Chopin | Public Domain | Roland Goretzki | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=484 | Mutopia piece 484 | `mutopia/mutopia-484-chopin-op-10-09-wfi.mid` |
| Aeolian Harp Étude | F. F. Chopin | Public Domain | Roland Goretzki | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=489 | Mutopia piece 489 | `mutopia/mutopia-489-chopin-op-25-01.mid` |
| Étude Op. 25 No. 2 | F. F. Chopin | Public Domain | Roland Goretzki | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=757 | Mutopia piece 757 | `mutopia/mutopia-757-ps-chopin-25-02.mid` |
| Ballade No. 4 | F. F. Chopin | Public Domain | Bruce J Keeler | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=422 | Mutopia piece 422 | `mutopia/mutopia-422-ballade-4.mid` |
| Fantaisie-Impromptu | F. F. Chopin | Public Domain | Guy D. Lederfein | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1693 | Mutopia piece 1693 | `mutopia/mutopia-1693-chopin-fantaisie-impromptu.mid` |
| Ballade No. 2 in B minor | F. Liszt | Public Domain | Vassily Checkin | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=236 | Mutopia piece 236 | `mutopia/mutopia-236-ballade.mid` |
| Étude Op. 2 No. 1 | A. Scriabin | Public Domain | Guy D. Lederfein | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1029 | Mutopia piece 1029 | `mutopia/mutopia-1029-scriabin-etude-2-1.mid` |
| Appassionata, 3rd mvt. | L. V. Beethoven | Public Domain | Stelios Samelis | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=937 | Mutopia piece 937 | `mutopia/mutopia-937-lvb-sonate-57-3.mid` |
| Sonata No. 32, 1st mvt. | L. V. Beethoven | Public Domain | Stelios Samelis | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1022 | Mutopia piece 1022 | `mutopia/mutopia-1022-lvb-sonate-111-1.mid` |
| Tempest, 1st mvt. | L. V. Beethoven | Public Domain | Stelios Samelis | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1509 | Mutopia piece 1509 | `mutopia/mutopia-1509-lvb-sonate-31no2-1.mid` |
| Pathétique, 1st mvt. | L. V. Beethoven | Public Domain | Chris Sawer | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=299 | Mutopia piece 299 | `mutopia/mutopia-299-pathetique-1.mid` |
| Sonata No. 2, Finale | F. F. Chopin | Public Domain | Roland Goretzki | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1727 | Mutopia piece 1727 | `mutopia/mutopia-1727-chp-op-35-4-scholz-fi.mid` |
| Raindrop Prelude | F. F. Chopin | Public Domain | Magnus Lewis-Smith | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=471 | Mutopia piece 471 | `mutopia/mutopia-471-chop-28-15.mid` |
| Minute Waltz | F. F. Chopin | Public Domain | Magnus Lewis-Smith | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=483 | Mutopia piece 483 | `mutopia/mutopia-483-chopin-valse-op64-no1.mid` |
| Waltz in B minor | F. F. Chopin | Public Domain | Roland Goretzki | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=511 | Mutopia piece 511 | `mutopia/mutopia-511-w10-h-moll-cfi.mid` |
| Arabesque No. 1 | C. Debussy | Public Domain | Keith OHara | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1777 | Mutopia piece 1777 | `mutopia/mutopia-1777-debussy-arabesque-1.mid` |
| Clair de Lune | C. Debussy | Public Domain | Keith OHara | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1778 | Mutopia piece 1778 | `mutopia/mutopia-1778-debussy-ste-bergamesq-clair.mid` |
| Rondo alla Turca | W. A. Mozart | Public Domain | Rune Zedeler and Chris Sawer | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=108 | Mutopia piece 108 | `mutopia/mutopia-108-kv331-3-rondoallaturca.mid` |
| Fantasia in D minor | W. A. Mozart | Public Domain | Andrés Necochea | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=2034 | Mutopia piece 2034 | `mutopia/mutopia-2034-fantasia.mid` |
| Sonata in C minor, 1st mvt. | W. A. Mozart | Public Domain | Will Oram | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=356 | Mutopia piece 356 | `mutopia/mutopia-356-sonata1.mid` |
| Für Elise (full) | L. V. Beethoven | Public Domain | Stelios Samelis | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=931 | Mutopia piece 931 | `mutopia/mutopia-931-fur-elise-woo59.mid` |
| Impromptu Op. 90 No. 1 | F. Schubert | Public Domain | Ph. Raynaud | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1192 | Mutopia piece 1192 | `mutopia/mutopia-1192-schubertf-d899-1-impromptu.mid` |
| Impromptu Op. 90 No. 2 | F. Schubert | Public Domain | Ph. Raynaud | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1551 | Mutopia piece 1551 | `mutopia/mutopia-1551-schubertf-d899-2-impromptu.mid` |
| Impromptu Op. 90 No. 4 | F. Schubert | Public Domain | Ph. Raynaud | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1552 | Mutopia piece 1552 | `mutopia/mutopia-1552-schubertf-d899-4-impromptu.mid` |
| Impromptu Op. 142 No. 1 | F. Schubert | Public Domain | Ph. Raynaud | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1194 | Mutopia piece 1194 | `mutopia/mutopia-1194-schubertf-d935-1-impromptu.mid` |
| Impromptu Op. 142 No. 2 | F. Schubert | Public Domain | Ph. Raynaud | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1195 | Mutopia piece 1195 | `mutopia/mutopia-1195-schubertf-d935-2-impromptu.mid` |
| Moment Musical No. 3 | F. Schubert | Public Domain | Claude Chaudron | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1023 | Mutopia piece 1023 | `mutopia/mutopia-1023-momentsno3.mid` |
| Träumerei | R. Schumann | Public Domain | Ying-Chun Liu | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=504 | Mutopia piece 504 | `mutopia/mutopia-504-schumannop15no07.mid` |
| Intermezzo Op. 118 No. 2 | J. Brahms | Public Domain | Aron Fay | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=535 | Mutopia piece 535 | `mutopia/mutopia-535-intermezzo.mid` |
| Waltz Op. 39 No. 10 | J. Brahms | Public Domain | John Mamoun | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=2164 | Mutopia piece 2164 | `mutopia/mutopia-2164-waltz-op39-10.mid` |
| In the Hall of the Mountain King | E. Grieg | Public Domain | Coyau | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1888 | Mutopia piece 1888 | `mutopia/mutopia-1888-dans-l-antre-du-roi-de-la-montagne.mid` |
| Wedding Day at Troldhaugen | E. Grieg | Public Domain | David Whipple | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=781 | Mutopia piece 781 | `mutopia/mutopia-781-troldhaugen.mid` |
| March of the Dwarfs | E. Grieg | Public Domain | Anonymous | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=2014 | Mutopia piece 2014 | `mutopia/mutopia-2014-troldtog.mid` |
| Dumka | P. I. Tchaikovsky | Public Domain | Vassily Checkin | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=341 | Mutopia piece 341 | `mutopia/mutopia-341-dumka.mid` |
| Scherzo in E minor | F. Mendelssohn-Bartholdy | Public Domain | Andrew C. Norman | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1653 | Mutopia piece 1653 | `mutopia/mutopia-1653-mendelssohn-scherzo-eminor.mid` |
| Maple Leaf Rag | S. Joplin | Public Domain | Chris Sawer | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=23 | Mutopia piece 23 | `mutopia/mutopia-23-maple.mid` |
| The Entertainer | S. Joplin | Public Domain | Chris Sawer | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=263 | Mutopia piece 263 | `mutopia/mutopia-263-entertainer.mid` |
| Prelude in C (BWV 846) | J. S. Bach | Public Domain | Tobias Erbsland | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=5 | Mutopia piece 5 | `mutopia/mutopia-5-wtk1-prelude1.mid` |
| Toccata in F-sharp minor | J. S. Bach | Public Domain | Imre Polik | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1814 | Mutopia piece 1814 | `mutopia/mutopia-1814-bwv910.mid` |
| Invention No. 13 | J. S. Bach | Public Domain | Allen Garvin | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=59 | Mutopia piece 59 | `mutopia/mutopia-59-bach-invention-13.mid` |
| Pineapple Rag | S. Joplin | Public Domain | Coyau | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1899 | Mutopia piece 1899 | `mutopia/mutopia-1899-pineapplerag.mid` |
| Elite Syncopations | S. Joplin | Public Domain | Benjamin Bloomfield | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1540 | Mutopia piece 1540 | `mutopia/mutopia-1540-elitesyncopations.mid` |
| A Breeze from Alabama | S. Joplin | Public Domain | Daniel Škarda | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=485 | Mutopia piece 485 | `mutopia/mutopia-485-a-breeze-from-alabama.mid` |
| Magnetic Rag | S. Joplin | Public Domain | Kurt Holtrop | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=441 | Mutopia piece 441 | `mutopia/mutopia-441-magnetic.mid` |
| Menuet, BWV Anh. 113 | J. S. Bach | Public Domain | Allen Garvin | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=74 | Mutopia piece 74 | `mutopia/mutopia-74-anna-magdalena-03.mid` |
| Minuet in G, BWV Anh. 114 (both hands) | C. Petzold (Anna Magdalena Bach notebook; listed by Mutopia under J. S. Bach) | Public Domain | Allen Garvin | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=75 | Mutopia piece 75 | `mutopia/mutopia-75-anna-magdalena-04.mid` |
| Menuet, BWV Anh. 116 | J. S. Bach | Public Domain | Allen Garvin | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=77 | Mutopia piece 77 | `mutopia/mutopia-77-anna-magdalena-07.mid` |
| Minuet in B-flat, BWV Anh. 118 | J. S. Bach | Public Domain | Steven McDougall | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1014 | Mutopia piece 1014 | `mutopia/mutopia-1014-bwv-118.mid` |
| Minuet in C minor, BWV Anh. 121 | J. S. Bach | Public Domain | Steven McDougall | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1613 | Mutopia piece 1613 | `mutopia/mutopia-1613-bwv-121.mid` |
| Polonaise in F, BWV Anh. 117a | J. S. Bach | Public Domain | Steven McDougall | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1013 | Mutopia piece 1013 | `mutopia/mutopia-1013-bwv-117a.mid` |
| Invention No. 4 | J. S. Bach | Public Domain | Allen Garvin | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=67 | Mutopia piece 67 | `mutopia/mutopia-67-bach-invention-04.mid` |
| Invention No. 8 | J. S. Bach | Public Domain | Allen Garvin | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=61 | Mutopia piece 61 | `mutopia/mutopia-61-bach-invention-08.mid` |
| Little Prelude, BWV 928 | J. S. Bach | Public Domain | Andreas Scherer | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=493 | Mutopia piece 493 | `mutopia/mutopia-493-prelude_9.mid` |
| Prelude in C-sharp minor (WTC I) | J. S. Bach | Public Domain | Davide Castellone | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=562 | Mutopia piece 562 | `mutopia/mutopia-562-bwv849a.mid` |
| Bourrée I (English Suite No. 1) | J. S. Bach | Public Domain | Allen Garvin | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=85 | Mutopia piece 85 | `mutopia/mutopia-85-bach-english-suite-1-bourree-1.mid` |
| Sonata No. 20, 1st mvt. | L. V. Beethoven | Public Domain | Stelios Samelis | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=776 | Mutopia piece 776 | `mutopia/mutopia-776-lvb_sonate_49no2_1.mid` |
| Sonata No. 20, Tempo di Menuetto | L. V. Beethoven | Public Domain | Stelios Samelis | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=777 | Mutopia piece 777 | `mutopia/mutopia-777-lvb_sonate_49no2_2.mid` |
| Sonata No. 19, 1st mvt. | L. V. Beethoven | Public Domain | Stelios Samelis | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=912 | Mutopia piece 912 | `mutopia/mutopia-912-lvb_sonate_49no1_1.mid` |
| Sonata No. 19, Rondo | L. V. Beethoven | Public Domain | Stelios Samelis | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=913 | Mutopia piece 913 | `mutopia/mutopia-913-lvb_sonate_49no1_2.mid` |
| Sonata No. 25, Andante | L. V. Beethoven | Public Domain | Stelios Samelis | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=956 | Mutopia piece 956 | `mutopia/mutopia-956-lvb_sonate_79_2.mid` |
| Pathétique, 2nd mvt. | L. V. Beethoven | Public Domain | Chris Sawer | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=295 | Mutopia piece 295 | `mutopia/mutopia-295-pathetique-2.mid` |
| Menuett, WoO 82 | L. V. Beethoven | Public Domain | Stelios Samelis | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=904 | Mutopia piece 904 | `mutopia/mutopia-904-menuett_woo82.mid` |
| Sonata K. 331, Menuetto | W. A. Mozart | Public Domain | Stelios Samelis | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=613 | Mutopia piece 613 | `mutopia/mutopia-613-kv331_2_1_menuetto.mid` |
| Sonata K. 331, Theme (without the variations) | W. A. Mozart | Public Domain | Stelios Samelis | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=614 | Mutopia piece 614 | `mutopia/mutopia-614-kv331_1_1_tema.mid` |
| Gigue, K. 574 | W. A. Mozart | Public Domain | Maurizio Tomasi | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=239 | Mutopia piece 239 | `mutopia/mutopia-239-k574.mid` |
| Marche funèbre, K. 453a | W. A. Mozart | Public Domain | Maurizio Tomasi | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=446 | Mutopia piece 446 | `mutopia/mutopia-446-k453a.mid` |
| Menuetto (Sonata Hob. XVI:27) | F. J. Haydn | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=186 | Mutopia piece 186 | `mutopia/mutopia-186-hob-xvi-27-ii-menuet-trio.mid` |
| Menuetto (Sonata Hob. XVI:28) | F. J. Haydn | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=211 | Mutopia piece 211 | `mutopia/mutopia-211-hob-xvi-28-ii-menuetto.mid` |
| Sonatina Op. 20 No. 1, Allegro | F. Kuhlau | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=232 | Mutopia piece 232 | `mutopia/mutopia-232-sonatine-1-allegro.mid` |
| Sonatina Op. 20 No. 1, Andante | F. Kuhlau | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=233 | Mutopia piece 233 | `mutopia/mutopia-233-sonatine-1-andante.mid` |
| Menuet | G. F. Handel | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=161 | Mutopia piece 161 | `mutopia/mutopia-161-12-menuet.mid` |
| Gavotte | G. F. Handel | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=151 | Mutopia piece 151 | `mutopia/mutopia-151-03-gavotte.mid` |
| Sonatina, HWV 585 | G. F. Handel | Public Domain | David Maddock | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=98 | Mutopia piece 98 | `mutopia/mutopia-98-sonatina-in-b-flat-major.mid` |
| Allemande | G. F. Handel | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=166 | Mutopia piece 166 | `mutopia/mutopia-166-17-allemande.mid` |
| Sonata K. 11 | D. Scarlatti | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=141 | Mutopia piece 141 | `mutopia/mutopia-141-sonatensatz.mid` |
| Sonata in C | D. Scarlatti | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=139 | Mutopia piece 139 | `mutopia/mutopia-139-ds_sonate_c.mid` |
| Kinderszenen: Of Foreign Lands | R. Schumann | Public Domain | Ying-Chun Liu | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=354 | Mutopia piece 354 | `mutopia/mutopia-354-schumannop15no01.mid` |
| Kinderszenen: Happy Enough | R. Schumann | Public Domain | Ying-Chun Liu | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=372 | Mutopia piece 372 | `mutopia/mutopia-372-schumannop15no05.mid` |
| Prelude Op. 28 No. 4 | F. F. Chopin | Public Domain | Magnus Lewis-Smith | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=468 | Mutopia piece 468 | `mutopia/mutopia-468-chop-28-4.mid` |
| Prelude Op. 28 No. 6 | F. F. Chopin | Public Domain | Magnus Lewis-Smith | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=469 | Mutopia piece 469 | `mutopia/mutopia-469-chop-28-6.mid` |
| Prelude Op. 28 No. 7 | F. F. Chopin | Public Domain | Magnus Lewis-Smith | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=470 | Mutopia piece 470 | `mutopia/mutopia-470-chop-28-7.mid` |
| Prelude Op. 28 No. 20 | F. F. Chopin | Public Domain | Magnus Lewis-Smith | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=472 | Mutopia piece 472 | `mutopia/mutopia-472-chop-28-20.mid` |
| Morning Prayer (Op. 39) | P. I. Tchaikovsky | Public Domain | Rem Zolotykh | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=2032 | Mutopia piece 2032 | `mutopia/mutopia-2032-01morningprayer.mid` |
| March of the Wooden Soldiers (Op. 39) | P. I. Tchaikovsky | Public Domain | Anonymous | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1806 | Mutopia piece 1806 | `mutopia/mutopia-1806-05marchofthewoodensoldiers.mid` |
| Old French Song (Op. 39) | P. I. Tchaikovsky | Public Domain | David McNamara | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=2080 | Mutopia piece 2080 | `mutopia/mutopia-2080-16oldfrenchsong.mid` |
| La Candeur (Op. 100) | J. F. F. Burgmüller | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=202 | Mutopia piece 202 | `mutopia/mutopia-202-25ef-01.mid` |
| Innocence (Op. 100) | J. F. F. Burgmüller | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=214 | Mutopia piece 214 | `mutopia/mutopia-214-25ef-05.mid` |
| Progrès (Op. 100) | J. F. F. Burgmüller | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=215 | Mutopia piece 215 | `mutopia/mutopia-215-25ef-06.mid` |
| La Gracieuse (Op. 100) | J. F. F. Burgmüller | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=217 | Mutopia piece 217 | `mutopia/mutopia-217-25ef-08.mid` |
| La Chasse (Op. 100) | J. F. F. Burgmüller | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=220 | Mutopia piece 220 | `mutopia/mutopia-220-25ef-09.mid` |
| Tendre Fleur (Op. 100) | J. F. F. Burgmüller | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=221 | Mutopia piece 221 | `mutopia/mutopia-221-25ef-10.mid` |
| L'Adieu (Op. 100) | J. F. F. Burgmüller | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=223 | Mutopia piece 223 | `mutopia/mutopia-223-25ef-12.mid` |
| Douce Plainte (Op. 100) | J. F. F. Burgmüller | Public Domain | Bas Wassink | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=228 | Mutopia piece 228 | `mutopia/mutopia-228-25ef-16.mid` |
| Melodic Study Op. 840 No. 1 | C. Czerny | Public Domain | Manuela | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=2146 | Mutopia piece 2146 | `mutopia/mutopia-2146-op840-1.mid` |
| Gymnopédie No. 1 | E. Satie | Public Domain | Evin Robertson | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=37 | Mutopia piece 37 | `mutopia/mutopia-37-gymnopedie_1.mid` |
| Gymnopédie No. 2 | E. Satie | Public Domain | Evin Robertson | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=38 | Mutopia piece 38 | `mutopia/mutopia-38-gymnopedie_2.mid` |
| Gymnopédie No. 3 | E. Satie | Public Domain | Evin Robertson | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=39 | Mutopia piece 39 | `mutopia/mutopia-39-gymnopedie_3.mid` |
| The Easy Winners | S. Joplin | Public Domain | Tom Harke | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=352 | Mutopia piece 352 | `mutopia/mutopia-352-winners.mid` |
| Peacherine Rag | S. Joplin | Public Domain | Antonio Palamà | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=335 | Mutopia piece 335 | `mutopia/mutopia-335-peacherine.mid` |
| Solace | S. Joplin | Public Domain | Magnus Lewis-Smith | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=482 | Mutopia piece 482 | `mutopia/mutopia-482-solace.mid` |
| Sugar Cane | S. Joplin | Public Domain | Daniel Škarda | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=467 | Mutopia piece 467 | `mutopia/mutopia-467-sugar-cane.mid` |
| Hungarian Melody | F. Schubert | Public Domain | Felix Braun | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=758 | Mutopia piece 758 | `mutopia/mutopia-758-ungarische.mid` |
| Impromptu Op. 90 No. 3 | F. Schubert | Public Domain | Ph. Raynaud | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1193 | Mutopia piece 1193 | `mutopia/mutopia-1193-schubertf-d899-3-impromptu.mid` |
| Song Without Words Op. 85 No. 1 | F. Mendelssohn-Bartholdy | Public Domain | Ryan Prince | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1744 | Mutopia piece 1744 | `mutopia/mutopia-1744-liederohneworte_-_op85_no1.mid` |
| Lualåt (Mountaineer's Song) | E. Grieg | Public Domain | Ted Stanion | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1628 | Mutopia piece 1628 | `mutopia/mutopia-1628-7-mountaineerssong.mid` |
| Åse's Death | E. Grieg | Public Domain | Deborah Lowrey | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=246 | Mutopia piece 246 | `mutopia/mutopia-246-02-lamortdase.mid` |
| Rumores de la Caleta | I. M. F. Albéniz | Public Domain | David Surtees | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=898 | Mutopia piece 898 | `mutopia/mutopia-898-rumores_de_la-caleta.mid` |
| Waltz Op. 39 No. 15 | J. Brahms | Public Domain | Brian D. Rude | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=794 | Mutopia piece 794 | `mutopia/mutopia-794-waltz-op39-15.mid` |

## CC BY (8)

| Title | Composer | Licence | Typesetter / contributor | Source page | Mutopia | File (under `renderer/songs/`) |
|---|---|---|---|---|---|---|
| Consolation No. 3 | F. Liszt | CC BY 3.0 | Ryan Prince | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1647 | Mutopia piece 1647 | `mutopia/mutopia-1647-liszt-consolation-no3.mid` |
| Consolation No. 1 | F. Liszt | CC BY 3.0 | Ryan Prince | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1654 | Mutopia piece 1654 | `mutopia/mutopia-1654-liszt-consolation-no1.mid` |
| Consolation No. 4 | F. Liszt | CC BY 3.0 | Ryan Prince | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1650 | Mutopia piece 1650 | `mutopia/mutopia-1650-liszt-consolation-no4.mid` |
| Kinderszenen: Curious Story | R. Schumann | CC BY 3.0 | Ying-Chun Liu | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=355 | Mutopia piece 355 | `mutopia/mutopia-355-schumannop15no02.mid` |
| Kinderszenen: Pleading Child | R. Schumann | CC BY 3.0 | Ying-Chun Liu | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=366 | Mutopia piece 366 | `mutopia/mutopia-366-schumannop15no04.mid` |
| Kinderszenen: An Important Event | R. Schumann | CC BY 3.0 | Ying-Chun Liu | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=374 | Mutopia piece 374 | `mutopia/mutopia-374-schumannop15no06.mid` |
| Mazurka Op. 6 No. 1 | F. F. Chopin | CC BY 3.0 | Ryan Prince | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1687 | Mutopia piece 1687 | `mutopia/mutopia-1687-mazurka-op6-no1.mid` |
| Venetian Gondola Song Op. 19 No. 6 | F. Mendelssohn-Bartholdy | CC BY 3.0 | Ryan Prince | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1679 | Mutopia piece 1679 | `mutopia/mutopia-1679-lieder-ohne-worte-venetianisches-gondellied-op19-no6.mid` |

## CC BY-SA (15), separate data files

| Title | Composer | Licence | Typesetter / contributor | Source page | Mutopia | File (under `renderer/songs/`) |
|---|---|---|---|---|---|---|
| Ballade No. 1 | F. F. Chopin | CC BY-SA 4.0 | Javier Ruiz-Alma | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1959 | Mutopia piece 1959 | `mutopia-sa/mutopia-1959-chopin-op23-ballade-1.mid` |
| Nocturne Op. 9 No. 2 | F. F. Chopin | CC BY-SA 3.0 | Renato Biolcati Rinaldi | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1590 | Mutopia piece 1590 | `mutopia-sa/mutopia-1590-chopin-nocturne-op9-n2.mid` |
| Prelude in C-sharp minor | S. Rachmaninoff | CC BY-SA 4.0 | Petro Kostandy | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=2033 | Mutopia piece 2033 | `mutopia-sa/mutopia-2033-rach-prelude-op3-no2.mid` |
| Prelude Op. 23 No. 5 | S. Rachmaninoff | CC BY-SA 4.0 | Joram Berger | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=2001 | Mutopia piece 2001 | `mutopia-sa/mutopia-2001-rach-prelude23-05.mid` |
| Prelude Op. 23 No. 2 | S. Rachmaninoff | CC BY-SA 4.0 | Abel Cheung | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1960 | Mutopia piece 1960 | `mutopia-sa/mutopia-1960-rach-prelude23-02.mid` |
| Sonata Facile, 1st mvt. | W. A. Mozart | CC BY-SA 3.0 | Alejandro Sierra | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=998 | Mutopia piece 998 | `mutopia-sa/mutopia-998-k545-1.mid` |

| Sonata Facile, 2nd mvt. | W. A. Mozart | CC BY-SA 3.0 | Alejandro Sierra | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1007 | Mutopia piece 1007 | `mutopia-sa/mutopia-1007-k545-2.mid` |
| Sonata Facile, 3rd mvt. | W. A. Mozart | CC BY-SA 3.0 | Alejandro Sierra | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1027 | Mutopia piece 1027 | `mutopia-sa/mutopia-1027-k545-3.mid` |
| Album for the Young: Melody | R. Schumann | CC BY-SA 2.5 | Philippe Hézaine | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=647 | Mutopia piece 647 | `mutopia-sa/mutopia-647-schumann-op68-01-melodie.mid` |
| Album for the Young: The Merry Farmer | R. Schumann | CC BY-SA 2.5 | Philippe Hézaine | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=659 | Mutopia piece 659 | `mutopia-sa/mutopia-659-schumann-op68-10-gai-laboureur.mid` |
| Prelude Op. 28 No. 1 | F. F. Chopin | CC BY-SA 4.0 | Donald Axel | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=411 | Mutopia piece 411 | `mutopia-sa/mutopia-411-chop-28-1.mid` |
| Gnossienne No. 1 | E. Satie | CC BY-SA 4.0 | Knute Snortum | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=2035 | Mutopia piece 2035 | `mutopia-sa/mutopia-2035-no_1.mid` |
| Gnossienne No. 2 | E. Satie | CC BY-SA 4.0 | Frédéric Duperray | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=2130 | Mutopia piece 2130 | `mutopia-sa/mutopia-2130-no_2.mid` |
| Gnossienne No. 3 | E. Satie | CC BY-SA 4.0 | Frédéric Duperray | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=2131 | Mutopia piece 2131 | `mutopia-sa/mutopia-2131-no_3.mid` |
| Arabesque No. 2 | C. Debussy | CC BY-SA 4.0 | Knute Snortum | https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1994 | Mutopia piece 1994 | `mutopia-sa/mutopia-1994-debussy_arabesque_2.mid` |