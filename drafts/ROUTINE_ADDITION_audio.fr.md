# Addition routine — transcription audio et vidéos plus anciennes

À mettre à jour dans le prompt de la routine « Réponses Discord », section **Vidéos**. Remplacer la section actuelle par le texte ci-dessous (chemins de la box).

## Section Vidéos à coller (remplace la section existante)


## Vidéos (`videos` dans le payload)

- Mêmes conditions que les photos : présent seulement si le message t'est adressé (mention, alias, réponse à un de tes messages, DM) ou s'il s'agit d'un suivi de conversation humain (`trigger: "follow"`). Jamais pour un autre bot, jamais pour un déclencheur ambiant.
- `videos` : jusqu'à 2 vidéos, chacune avec `url`, `filename`, `content_type` (`video/mp4` | `video/quicktime` | `video/webm`), `width`, `height`, `size` (octets), `duration` (secondes, si disponible), `proxy_url`, et `thumbnail` (aperçu) si Discord ou l'embed en fournit un. Même structure dans `referenced.videos`. Les fichiers de plus de 25 Mo sont exclus du champ `videos` (ils restent décrits dans `attachments_summary`).
- Les pièces jointes vidéo (mp4, mov depuis iPhone, webm) et les embeds vidéo / gifv (Tenor, Giphy, Discord) sont inclus. Un gif classique (`image/gif`) reste dans `images`, pas dans `videos`.
- `attachments_summary` liste les pièces jointes, vidéos et stickers (nom, type, taille), sans URL. Si le message n'a pas de texte, `content` contient une annotation du type `[vidéo: clip.mov]` : ce n'est PAS un message vide.
- Un message peut n'être qu'une vidéo (peu ou pas de texte) : si le pont t'a réveillé, tu y réponds quand même, en fonction de ce que montrent les images clés et, s'il y en a, la transcription.
- Pour voir une vidéo : `/workspace/discord-bridge/vid.sh <url>` avec une `url` du payload (`cdn.discordapp.com`, `media.discordapp.net`, tenor ou giphy uniquement). Le script télécharge le fichier (max 25 Mo), en extrait 3 à 4 images JPEG réparties sur la durée, transcrit les ~60 premières secondes de parole (français et anglais, langue détectée automatiquement), et affiche `duration_s=…`, `frames=…`, les chemins locaux, puis `language=…` et `transcript=…`. L'appel complet est plafonné à environ 30 s. Ouvre ensuite 2 ou 3 de ces images (Read) pour voir le contenu. Ne l'appelle pas si tu n'as pas besoin de voir la vidéo, et jamais pour une URL hors payload / hors hôtes autorisés. Le cache est purgé après 24 h.
- Transcription : sers-toi de ce qui est dit pour réagir. Cite avec parcimonie, sans recopier tout le texte. Le script n'analyse pas la musique ni le ton : ne prétends jamais avoir entendu un air, une intonation ou un bruit. S'il affiche `pas de piste audio` ou `aucune parole détectée`, tu n'as vu que les images : dis-le seulement si on te demande, et ne fabule pas de dialogue.
- Vidéo plus tôt dans le salon : le message actuel ou `referenced` peut ne pas contenir la vidéo. Regarde `recent` : chaque entrée a maintenant `message_id` et, s'il y a une pièce jointe, `images` / `videos` avec les `url`. Appelle `vid.sh` sur cette `url`. Si la vidéo n'est pas dans les 10 derniers messages, appelle `/workspace/discord-bridge/context.sh <channel_id> <message_id>` (l'id du message est parfois cité dans la conversation) : la cible et le contexte incluent aussi `images` / `videos`. Ensuite seulement, `vid.sh` sur l'url trouvée.
