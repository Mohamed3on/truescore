// Real production review set (Google Maps "Sukito", Alicante) captured from a
// live /api/summarize request. Large and nuanced — mixed sentiment, specific
// dishes (takoyaki, karepan, shiro cookie, karaageddon), an unusual location
// (an abandoned market/food hall), explicit value mentions, and one clear
// negative — so it discriminates summary quality far better than the small
// cached fixtures. Consumed by evals/compare.ts.
const fixture = {
  place: 'Sukito',
  filter: null as string | null,
  reviewTexts: [
    `[2026-05-10] Don't expect a restaurant with Japanese decor or anything fancy, because it won't be like that. It's located inside a food hall.
Here, the food is the priority, and boy, do they deliver.
I dare say they're the best takoyaki I've ever had. Super creamy and intensely flavorful.
I didn't get a picture of the karepan, but we were so tempted by how good it looked; a kind of fried bun with panko breadcrumbs and a curry filling. Our main courses were the Bifusoba and the Mazesoba. I prefer the latter, but both were very good; the portion wasn't huge, but it was just right.
Now, the desserts were amazing. The white chocolate and miso cookie was delicious, and the matcha tiramisu was so refreshing. If I had to choose just one, it would be the cookie.

Without a doubt, this is a great find that will become one of my go-to options when I don't know what to eat.`,
    `[2026-02-22] First visit and it's already among my favorite restaurants!

Starters: takoyaki and karepan; main courses: masezoba and karaageddon; desserts: shiro cookie and brownie cookie. Everything was delicious, but if I had to replace one dish, it would be the masezoba, as I prefer bolder flavors.

The two dishes that blew me away were: the karepan, with a dough that reminds me of suso, incredibly fluffy inside and very crispy outside, filled with a delicious, mild curry; and the shiro cookie (made with white chocolate, miso, and butter). I'm very particular about desserts and I make my own cookies, and these were unbeatable.

You can place your order through their WhatsApp (and reserve a table), as they have an updated menu with the daily available items.

Don't miss it!`,
    `[2026-03-28] We went for dinner tonight for our anniversary and were absolutely blown away.

Our first impression was excellent, both in terms of ambiance and service. The waitress was very friendly and the atmosphere was incredibly peaceful and welcoming.

We ordered three appetizers, two main courses, and two desserts to share. Everything was delicious, but we'd especially like to highlight the original yakisoba (super tasty, the best I've ever had) and the miso and white chocolate cookie, which was the perfect ending to a delightful dinner.

The price was surprisingly good for the amount of food we ordered, and the staff was incredibly friendly. You can tell it's a business run with a lot of love.

We'll definitely be back to try what we missed!`,
    `[2026-01-17] A fantastic place for Japanese food. We ordered karaage and gyoza as starters. For our main course, we had yakisoba; I ordered the umisoba. The flavor was excellent, and the portions were generous enough to eat without feeling stuffed. The combination of flavors is what really stands out, in my opinion; I haven't had anything quite like it anywhere else. For dessert, we ordered dorayaki with anko and dulce de leche, both delicious. The prices are about average these days, but you know you're getting quality. You can watch them prepare the dishes right in front of you. We ate there, although it's not really designed for dining in, there are a couple of tables available. The staff were incredibly friendly and helpful.`,
    `[2026-01-17] A hidden gem you can't miss. The food is delicious and the staff are so friendly ☺️ They recommended the starters and it was a great choice. I recommend the Karepan, which is like a crispy bun with curry, and the Korokke, which is a super soft potato and minced meat croquette (I'd never tried anything like it before). For our main course, we ordered the yakisoba and wow, what a flavor! I ordered the Bifusoba and the shiitake was incredible 🤤
To finish, the desserts are delicious, but if you have to try one, it has to be the cookies. Yes, the white chocolate one in particular is spectacular 😍 It's definitely worth trying; it's one of my favorite Japanese restaurants in Alicante.`,
    `[2026-03-30] It's not a particularly eye-catching place from the outside, but once you try it, you realize it's absolutely worth it. The food has a homemade feel, and it's not your typical sushi place; it's more about hot dishes, and honestly, everything is delicious. It's a simple, small place, but the food is excellent, and they more than deliver on that front. The service is also good. My only complaint would be that they could modernize the way the bills are printed; they shouldn't be handwritten. A highly recommended place, and one I'll definitely be back to.`,
    `[2026-03-08] Japanese food 10/10. My partner and I ordered Korokke and Katepan as starters. The Takoyaki looked amazing, but I'll definitely be back to try them. For our main courses, we had Karaageddon (highly recommended) and Umisoba (damn, that flavor!). For dessert, we had Shiro cookie and Dorayaki. And of course, Japanese beer. Around €20 per person, you leave stuffed and wanting to come back to try more things. The guys who run it are also 10/10; they put their heart and soul into every dish. I'll definitely be back.`,
    `[2026-04-10] Sukito is a truly authentic Japanese restaurant with a short but well-chosen menu, where every dish stands out for its flavor and quality. The value for money is excellent, and the staff is friendly, attentive, and welcoming, making you feel comfortable from the moment you arrive. Thanks, Charly, for the recommendation.

As a side note, it's located inside an abandoned neighborhood market, a rather peculiar place that might surprise you at first, but that's precisely what makes it so original and special.`,
    `[2025-11-11] We ordered delivery and the experience was excellent. The food arrived on time, well-packaged, and in perfect condition. Each dish retained its temperature and flavor, demonstrating care in both preparation and delivery.
The ingredients tasted fresh, and the seasoning was consistent throughout the entire order. It's clear the restaurant maintains its quality even outside the dining room.
Overall, the service was efficient, and the food was truly delicious. I would definitely order again.`,
    `[2025-12-14] We just finished eating and everything was fantastic.
The octopus balls called Takoyaki were divine. The absolute best of everything we ordered.
The BBQ pork Gyozas with Orensi orange sauce were excellent, 100% recommended, and the Bifusoba noodles were great too.
For dessert, we tried the Dulce de Leche Dorayaki and the Shiro Cookie.
Both were delicious, but the cookie is super sweet and gets cloying quite quickly, so I recommend sharing it; a small piece is enough.
We'll be back soon.`,
    `[2025-11-09] There's nothing like being sick and ordering from this place. The Karaageddon is spicy and sweet, so perfectly balanced. I'd never tried dango before, and it was an amazing experience. I tried a small piece of karepan and dorayaki, but I was so full that I saved them for breakfast. And everything arrived warm and freshly made, perfect for a cold. You can tell the cook makes it with love and care, and knows what they're doing.
Next time we'll definitely order from there 💖💖`,
    `[2026-02-19] This restaurant is top-notch! To begin with, it's located in a very welcoming arcade that we could access with our furry friend (pet-friendly). Furthermore, the quality of all their dishes is outstanding. We had never tried the Karepan before, and we loved it. We also sampled their main dishes with rice and yakisoba.

We will definitely be back to try everything else we didn't get to order.

PS: Don't leave without trying the white chocolate cookie; it's delicious! 🥴`,
    `[2026-02-14] A peaceful atmosphere; reservations are essential as it's very small with few tables. The service is very attentive, offering recommendations on what to order and whether it's spicy or not. The menu isn't extensive, but it's sufficient. Everything is homemade, even the sauces. Don't expect anything fancy; it's Japanese street food. Each dish has distinct flavors and aromas, each one unique, and it tastes and smells homemade. We'll definitely be back.`,
    `[2026-03-01] A spectacular find! The food was incredible, the portions very generous, and the flavor authentic. The owners are lovely and explain all the dishes perfectly. We'll definitely be back; we were absolutely blown away by everything we ordered. The desserts made by the owner are also noteworthy; we ordered the miso and white chocolate cookie, a 10 out of 10! And the quality-to-price ratio is excellent. We can't wait to return! Congratulations, guys!`,
    `[2026-01-31] AUTHENTIC

If you're looking for authenticity, this is the place. The flavor of each dish will remind you of your trip to Japan.

The dishes were incredible, the karepan was excellent, and the mazesoba was delicious.

We have to talk about the desserts—they were amazing. We fell in love with the white miso cookie and the dorayaki.

Two super friendly young people are at the stoves. Highly recommended.

Thank you, Sukito, for your authenticity.`,
    `[2025-11-06] Spectacular Japanese food!!!! It's not your typical fare. I ordered the karepan and the original noodles… For dessert, dorayaki. Everything was delicious! What surprised me most was the karepan; it transported me back to when I was in Japan, something I hadn't seen in Spain since. The chefs were lovely; they told me they had lived there for inspiration, and it shows. It was like returning to its most authentic flavors.`,
    `[2026-03-30] You can tell everything is homemade; the takoyaki and karepan are out of this world. I also highly recommend both the chashudon and the gyuudon—the portions are more than generous and the flavor is delicious. We were tempted to try the matcha tiramisu, but the dorayaki and cookies were also fantastic. I recommend it without hesitation. When you're craving Japanese food beyond sushi or ramen, this is the place for you.`,
    `[2026-03-07] My partner and I went to try it out, as we were looking for Google reviews of a reasonably priced Japanese restaurant, and we were pleasantly surprised. The food was high-quality, homemade, and reasonably priced, and the staff were incredibly friendly. The place isn't the most elegant, but you can always order takeout, and what could be better than eating it right by the beach? We'll definitely be back.`,
    `[2026-06-07] I can't really compare, as I think this is only the second time I've eaten at a Japanese restaurant, but the Takoyaki octopus balls were interesting, the poteto sarada was very intriguing—the mix of ingredients was an explosion of flavors that I really appreciated—and the chicken yakitori didn't disappoint. Overall, everything was very tasty. We should encourage and support initiatives like this.`,
    `[2025-11-11] I ordered delivery on opening day and what can I say… the karee pan transports you straight to Japan, it was amazing. I also tried the korokke, delicious. Finally, the mazesoba, and that was the icing on the cake. It's takeout, but I hope they keep growing. Without a doubt, a Japanese restaurant to keep an eye on, with food made with a lot of love and expertise. I'll be ordering again tonight 😊`,
    `[2026-03-18] A truly delightful experience! It was clear that every dish we tried was made with fresh ingredients—they were bursting with variety and flavor, and beautifully prepared! The owners' youth and enthusiasm are evident in their natural and friendly service. The place has a slightly hidden feel, which adds a special, tranquil touch. Congratulations, guys, you've gained some new customers!`,
    `[2026-03-24] Authentic Japanese restaurant located in a small shop in the Albufereta food hall.
Their menu is small, but every dish is bursting with flavor, especially their classic yakisoba 🍜
I've been back several times and will definitely return 💯
If you go, make a reservation as they have limited seating, but if you decide to try it at home, the delivery arrives in perfect condition.`,
    `[2026-06-14] We received a recommendation for this restaurant from young people with a great desire to do things well.
They ventured out to enjoy the experience and it was a success. Located in the galleries of Albufereta is this small, well-designed place that takes you on a gastronomic adventure with its food.
In addition, the service is excellent.
We will definitely be back.`,
    `[2026-03-07] We discovered this place through a video and absolutely loved it! We ordered a couple of appetizers and two main courses. Everything was delicious, especially the Karepan, the Umisoba, and the Gyūdon. We would have loved to take more photos, but everything was so good we forgot. We'll definitely be back to take them ❤️. Book now to enjoy this amazing experience 😋`,
    `[2026-04-09] High-quality, homemade food cooked right in front of you, no tricks. Don't expect a fancy place with tables and silverware because the real luxury is in what matters most: the food. We tried several dishes, all absolutely delicious. Congratulations, keep up the great work! We'll be back very, very soon. You're sure to be a huge success!`,
    `[2025-12-21] It's become one of my favorite Japanese restaurants. The food is delicious and the staff is incredibly friendly and welcoming. We've been a few times now and it's always been great. I highly recommend the yakisoba and takoyaki; they're fantastic. We also tried the dorayaki and the cookies, and the desserts are amazing.`,
    `[2026-05-02] I'm not familiar with authentic Japanese cuisine, but the dishes have exquisite and well-balanced flavors. The service is very friendly and the setting is quite unique, but the excellent food overshadows the fact that you're in the corridor of a practically abandoned shopping arcade; absolute tranquility.`,
    `[2026-02-12] I'm absolutely delighted!! The food was delicious, everything was so good and well prepared, it's a real pleasure. I hope they do well in their future endeavors, I'll be back soon. The chocolate cookies were amazing! The white miso one was spectacular 😋😋❤️😋😋 The staff were so friendly!!`,
    `[2026-02-18] I've tried three dishes and I can't wait to go back to try new things; it's such a pleasure to eat at places like this. The food was delicious, the service was incredibly friendly, and the desserts were simply divine. I recommend calling ahead to make a reservation as space is limited.`,
    `[2026-05-25] We were really looking forward to trying it and it definitely surprised us. A Japanese tavern with incredible flavors. Everything was spectacular. We'll definitely be back. And the staff were so friendly and attentive; we spent a good while congratulating them and chatting with them.`,
    `[2025-11-14] In just one week since opening, it has become one of my favorite places to enjoy authentic Japanese food. The karageddon was one of my favorite dishes, and the dessert cookie is so good it's insane. Thank you for opening a place like this in Alicante; you've outdone yourselves.`,
    `[2026-06-06] Amazing place to enjoy a good meal, with a very friendly atmosphere where you discover the art of Japanese cuisine in a peaceful setting.

"Amazing place to enjoy a good meal, with a very friendly atmosphere where you discover the art of Japanese cuisine in a peaceful setting."`,
    `[2025-11-19] Blessed be the hands of the cook(s). The kitchen is located in an old school centro commercial forgotten by time. The couple that runs it strike me as pioneers that could convert this abandoned place into the next trendy location. I hope it catches on. I'll be coming back.`,
    `[2025-11-11] We ordered delivery and the wait was really short.
The food was amazing and absolutely delicious.
My partner and I had a fantastic dinner.
(We would have posted a picture, but the food disappeared so fast it was so good 😅)
We'll definitely order again! 👌🏻`,
    `[2026-04-02] The food was great, and the service was excellent. Even though there was a mistake with the bill, it was very nice to see that in addition to the good service and quality of the food, they were honest about the cost of what you ordered. Highly recommended.`,
    `[2026-03-12] The location is so random that it makes it special. An old, semi-abandoned market gives it a unique feel.

The food is flavorful and delicious. There aren't many dishes to choose from, but they're all well-prepared.

Great value for money.

We'll be back.`,
    `[2026-04-17] We went for dinner and were absolutely delighted. It's clear that everything is prepared with care and attention. The dishes were delicious, and the desserts even better. The service was incredibly friendly and attentive. MAKE GALERIAS GREAT AGAIN!`,
    `[2026-04-30] You know those hard-to-find places? Here's a hidden gem of one of the best Japanese restaurants in Alicante. The food is worth the trip. Special mention goes to the korokke and karepan as starters, and the karageddon and gyūdon. Best of luck, guys!`,
    `[2026-03-20] There's no denying the skill, enthusiasm, and passion! Something like what they offer here is rare in the area, and that's truly remarkable. Anyone who's tried something similar won't be surprised, but they'll certainly appreciate it.`,
    `[2026-03-14] We've been there several times and everything has been top-notch, they're fantastic, you can't find a single fault with them, the product is delicious and very well prepared, you can tell they put their heart and soul into cooking it.`,
    `[2026-01-29] Little to say, the food was spectacular and the service incredible. It's a pleasure to find places where they pay such attention to detail and you can tell they enjoy what they do. Everything was delicious, I'll definitely be back.`,
    `[2026-03-01] We ate there for the first time today, tried six dishes, and loved them all!! The staff are incredibly friendly and the cooking is amazing. We'll definitely be back 🤍`,
    `[2026-01-04] The vegetable gyozas with mango sauce and the rice with pork belly were both delicious. It was more than enough for one person, and I promise to come back and try other things. It's super convenient; I take the elevator from home.`,
    `[2026-03-27] March 2026
I went to pick up my order 😋🥡🥢
Everything was neatly arranged in its boxes and nice and warm…
Use WhatsApp to order; the menu is detailed and complete (very easy).
Now I just have to try 👅 everything else 🥟🍪🍜🍣🍛`,
    `[2025-11-09] Finally, a place where we could find authentic Japanese food! We loved everything we ordered. The noodles were excellent, the gyozas were spectacular, and there was a kind of giant, stuffed croquette. Everything was delicious!`,
    `[2025-11-14] The food is incredible! The couple who work there are lovely and prepare everything with so much love, and it shows. 😍 The food really surprised me, from the appetizers to the dessert. Speechless, I'll definitely be back. 🔥`,
    `[2026-03-29] The concept of the place is quite risky. Open-minded for those with discerning palates. The food and service were very good, but it lacked a few things: soy sauce, wine, more traditional dishes... but it wasn't bad either.`,
    `[2025-11-14] It's amazing and the prices are fantastic! Everything is so delicious, so incredibly delicious. I'll be dragging my friends over to try it soon. P.S. The giant meat croquette is incredible! 😍 Highly recommended. ♥️🔥👍`,
    `[2026-02-18] Don't be fooled! This is a clear example of how Instagram isn't real. The galleries are cool, but drinking from plastic cups and eating with plastic forks isn't right. The food was nothing special; we won't be back.`,
    `[2026-03-07] The food was amazing!!! It had been ages since I'd been to a restaurant and had absolutely no complaints. Spectacular! And the service was fantastic, very attentive and super friendly 😊 We'll definitely be back!!`,
    `[2025-11-30] If you're looking for truly authentic Japanese food, this is the place for you!

It's a small restaurant run by a lovely young couple who put care and attention into every dish on the menu.

Highly recommended!`,
    `[2026-03-25] A great find in the Albufereta area. Japanese food made with care, delicious, and with quality ingredients. A young and relaxed project, overflowing with enthusiasm and attention to detail. Congratulations!`,
    `[2026-05-08] Everything was delicious, the staff were very friendly, and we felt relaxed and thoroughly enjoyed 100% homemade Japanese cuisine without it all being sushi and rolls and such. We'll definitely be back!`,
    `[2026-02-15] We went to Sukito and loved it. The food was spectacular, everything was delicious and perfectly prepared.
The staff were incredibly friendly; it was definitely a great choice. We'll certainly be back.`,
    `[2025-11-09] We ordered gyozas, umisoba, orenji, and desserts.

Everything was amazing, we barely even took pictures. The gyoza and its supreme sauce, the smooth and sweet matcha dessert—I'll definitely be back!`,
    `[2026-02-21] I ordered takeout and everything was delicious. The original noodles were amazing. For dessert, we finished with a chocolate and peanut cookie that has become my favorite. We'll definitely be back.`,
    `[2026-02-04] The food was excellent, we especially loved the noodles with beef. I hope they do well because I plan to go regularly. The miso and white chocolate cookie was the best cookie I've ever had.`,
    `[2026-06-07] A hidden gem in the heart of Albufereta. Delicious food, great atmosphere, and fantastic service. Very competitive prices. Go as soon as possible for your first, second, or umpteenth visit.`,
    `[2026-03-22] Everything was delicious! The food had an amazing flavor. We loved it. I'm only going to upload one photo because I forgot to take the others, I was so eager to eat it all!
Congratulations!`,
    `[2026-04-10] As close to the original Japanese dishes as you can. Excellent flavors with a great ambience. The service is very friendly and even though the menu is pretty small, the options are great.`,
    `[2026-02-01] I highly recommend this place. The service is incredibly attentive and the food is spectacular. You can tell they're professionals and put a lot of love into what they do.`,
    `[2025-11-11] We ordered a couple of things and everything looked great. The donburi was delicious and the karaageddon with spicy fried chicken was amazing. I'll definitely order again.`,
    `[2026-02-14] A new Asian restaurant tucked away in a hidden corner, with a remarkable talent for crafting exquisite, expertly prepared dishes bursting with authentic Japanese flavor.`,
    `[2026-02-26] Back to basics. Unpretentious. Sukito is the result of focusing on what really matters: good food, good service, good ideas, good prices, and zero pretense. A pleasure.`,
    `[2026-04-11] We really enjoyed all the dishes we ordered. The menu isn't very extensive, but you can tell everything is homemade. The service was also excellent. We'll be back soon.`,
    `[2026-03-01] We ate there for the first time today, tried six dishes, and loved them all!! The staff are incredibly friendly and the cooking is amazing. We'll definitely be back 🤍`,
    `[2026-01-31] The food was spectacular! We saw the reviews and wanted to try it, and it was indeed very good.
The place is hard to find, but it's worth it. We'll definitely be back.`,
    `[2025-11-09] I loved everything I ordered, the sauces were great, the noodles were delicious, the chicken was super good, the croquettes were amazing. Overall, I'll keep ordering.`,
    `[2026-04-02] Excellent quality in every dish; you can tell when the product is fresh and the experience of the cooks is evident, plus everything is completely made in the kitchen.`,
    `[2025-12-27] The restaurant is inside the building, through the entrance that leads to the parking lot outside. The food is very authentic and very good; the takoyaki is amazing.`,
    `[2025-11-18] So happy to have this great new restaurant in my neighborhood! Everything was delicious😋.  My favorite.. so far is the Takoyaki 🐙
Looking forward to next time.`,
    `[2026-04-05] The Japanese food was delicious and a welcome change from typical buffets. A great initiative to support a young, enthusiastic group. Unbeatable value for money.`,
    `[2026-02-26] What a surprise! A unique atmosphere, super friendly owners, and the food… 10/10!! Short menu, delicious, and made with love.
The concept is really cool! Bravo!`,
    `[2025-11-17] Bifusoba and karaageddon are delicious, and the white chocolate cookie is divine. The girl and guy who served us were super friendly. We'll definitely be back.`,
    `[2026-03-26] Highly recommended. Delicious food, super friendly service, and a very peaceful atmosphere. I'll definitely be back. The white chocolate cookies are amazing.`,
    `[2026-03-08] Japanese food with an incredible flavor and a menu that makes you want to come back to keep trying dishes that you can't find in other Asian restaurants.`,
    `[2026-04-25] Innovative food and recipes for Spanish palates. Highly recommended and reasonably priced. It's a shame they don't yet have wine to pair with the menu.`,
    `[2025-11-20] Absolutely fantastic!!! I ordered two types of gyoza and some yakisoba, and they were spectacular. I'll definitely be back soon to try more things.`,
    `[2026-03-15] We loved it, it was super delicious and the service was very friendly. We'll definitely be back to try more things from the menu. 100% recommended.`,
    `[2026-01-17] Dennis and Paula were lovely, and the food was fantastic. It's very different from what we're used to seeing as Japanese, and it's delicious.`,
    `[2026-03-26] The food was great and the staff were super friendly! The only downside is the menu is quite limited... I wish they had some gyozas or sushi!`,
    `[2026-02-15] A great find at Sukito. Incredible quality and amazing flavors. We left very satisfied, highly recommended if you like good Japanese food.`,
    `[2025-12-05] These old galleries have a hidden gem. Great experience in a totally random place. Try the Shiro cookies; they're homemade, amazing. 10/10`,
    `[2026-01-22] The takeaway food is really good...definitely worth it. And the guys who run it are very friendly. A great option in the neighborhood.`,
    `[2026-03-08] Fantastic food and 10/10 service, it's incredible to be able to enjoy such authentic flavors in Alicante. We will definitely be back.`,
    `[2026-02-11] Simply amazing!!! I wish you all the best!
Good luck with this very interesting project!! It's been a real pleasure!! We'll be back`,
    `[2025-11-13] I didn't know what to order and they gave me great advice. The food was very good and the service was fast. I will recommend it.`,
    `[2026-02-15] Authentic Japanese, very charming. They're just starting out and it shows, but the quality is there. We have to give them time.`,
    `[2026-05-06] The food at Sukito is amazing. I highly recommend the noodles with pork belly and the cheesecake. I'll definitely be back! 😊`,
    `[2026-03-15] Everything was great. The noodles with prawns were delicious. Different from other Japanese restaurants. Highly recommended.`,
    `[2026-05-30] It was our first time there and everything was delicious. The staff was incredibly attentive. We'll definitely be back.`,
    `[2026-03-06] What an incredible experience! Everything was great and authentic, excellent value for money, I highly recommend it!`,
    `[2026-02-05] 100% Recommended
I ordered takeout and they were super fast, and the food was delicious. It transported me to Japan.`,
    `[2026-05-22] The food was all amazing. I've been several times, and everything I've tried has been delicious. Lovely people.`,
    `[2026-04-26] The food was delicious, the atmosphere was peaceful, the service was great and super fast, highly recommended!!`,
    `[2026-02-05] We loved it!! The food is clearly homemade; there's quality and care in every dish. We'll definitely be back!!`,
    `[2026-04-30] A very good Japanese restaurant in an unusual setting. The food was very good, and the service was excellent.`,
    `[2026-02-07] The food was very well prepared and the portions were perfect. The service was very punctual. We'll be back!`,
    `[2026-03-14] Literally some of the best Japanese food I've ever had; the service, the atmosphere, everything was perfect.`,
    `[2026-02-14] 100% recommended. The best takoyaki I've ever had, all the food is incredible. We'll definitely be back.`,
    `[2026-03-16] Excellent prepared Japanese food! Dont let yourself scared by the location, the food is worth a detour.`,
    `[2026-04-11] Delicious food in a hidden but charming spot. Reservations recommended, as there are only a few tables.`,
    `[2026-05-03] Authentic. Delicious flavors. Everything was excellent, and the service was outstanding. We loved it.`,
    `[2026-04-29] It was our first time trying Japanese food, and we loved it! I highly recommend it. We'll be back!`,
    `[2025-12-06] Highly recommended, everything was delicious, the staff were lovely, and the service was 10/10.`,
    `[2026-03-25] Not many options, but all delicious. Quiet atmosphere and very friendly service. A great find!`,
    `[2026-06-14] Everything was delicious, a must-visit if you like authentic Japanese food. Congratulations!`,
    `[2025-11-07] It's takeout, but the food and desserts are amazing. Highly recommended. Totally Japanese.`,
    `[2026-04-11] I had lunch with my friends today and the food was amazing! The staff was super attentive.`,
    `[2025-12-17] Everything was amazing!!! We'll be back to try more things...I definitely recommend it!!`,
    `[2026-03-14] Excellent food, very friendly and welcoming service, 100% recommended!! We'll be back!!!`,
    `[2026-03-14] We really enjoyed the mazesoba, highly recommended. The place was pleasant and peaceful.`,
    `[2026-04-09] A real find! The food was excellent, and the service was fantastic.
You can't miss it!`,
    `[2026-04-08] The food is amazing. The staff are very attentive and the atmosphere is very pleasant.`,
    `[2026-05-02] The food and service were excellent, and I highly recommend their pork belly noodles!`,
    `[2026-04-12] The food was amazing and the staff were very friendly. I will definitely be back.`,
    `[2026-05-17] Everything was perfect! The food was delicious, it tasted like it was in Japan!`,
    `[2026-04-09] Everything is delicious and the owners are lovely. We'll definitely be back! 👏`,
    `[2025-12-13] Highly recommended. Very tasty and good food. Friendly people. Excellent!!!!!`,
    `[2026-04-01] Wonderful experience, everything was delicious and they were so lovely!`,
    `[2026-03-28] Amazing food! The noodles were out of this world! We'll be back.`,
    `[2026-05-30] The food was very well prepared and the service was very good.`,
    `[2026-06-15] Relaxed and delicious. Excellent service and helpful advice.`,
    `[2026-02-11] The food was spectacular and the couple were super friendly`,
    `[2025-11-19] What a find!!!! I loved the food. Will definitely repeat.`,
    `[2026-05-17] Everything is delicious, we will definitely be back ❤️`,
    `[2026-05-09] Everything is great and the service is very friendly.`,
    `[2026-01-07] Great food, excellent service.
Highly recommended.`,
    `[2026-04-02] Everything was delicious.
The staff were lovely.`,
    `[2026-04-01] Homemade, delicious, and very attentive.`,
    `[2026-04-06] Good, delicious food, I'd order again.`,
    `[2026-03-13] Food is amazing
Strong recommend !`,
    `[2025-12-07] Wonderful. So kind!`,
  ],
};

export default fixture;
