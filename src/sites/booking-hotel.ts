// Booking.com hotel page - recent reviews analysis
const graphqlEndpoint = 'https://www.booking.com/dml/graphql?';

function waitForHotelId(callback: (id: string) => void) {
  const checkInterval = setInterval(() => {
    const hotelIdInput = document.querySelector('input[name="hotel_id"]') as HTMLInputElement;
    if (hotelIdInput?.value) { clearInterval(checkInterval); callback(hotelIdInput.value); }
  }, 500);
}

waitForHotelId((hotelId) => {
  const destId = (document.querySelector('input[name="dest_id"]') as HTMLInputElement).value;

  const createPayload = (skip: number) => ({
    operationName: 'ReviewList',
    variables: {
      input: {
        hotelId: parseInt(hotelId), hotelCountryCode: 'gr', ufi: parseInt(destId),
        sorter: 'NEWEST_FIRST', filters: { text: '' }, skip, limit: 25,
      },
    },
    extensions: {},
    query: `query ReviewList($input: ReviewListFrontendInput!) {
      reviewListFrontend(input: $input) {
        ... on ReviewListFrontendResult {
          reviewCard { reviewScore guestDetails { countryName } bookingDetails { customerType roomType { name } checkoutDate } }
        }
      }
    }`,
  });

  const fetchReviews = (skip: number) =>
    fetch(graphqlEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(createPayload(skip)),
    }).then(r => r.json());

  Promise.allSettled([fetchReviews(0), fetchReviews(25), fetchReviews(50), fetchReviews(75)])
    .then((results) => {
      const allReviews = results
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
        .flatMap(r => r.value.data.reviewListFrontend.reviewCard);

      const customerTypes = [...new Set(allReviews.map((r: any) => r.bookingDetails.customerType))] as string[];
      const roomTypes = [...new Set(allReviews.map((r: any) => r.bookingDetails.roomType.name))] as string[];

      const wrapperElement = document.createElement('div');
      wrapperElement.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;border-top:1px solid #ccc;padding:10px 12px;margin:10px 0';

      const titleElement = document.createElement('div');
      titleElement.textContent = 'Recent Reviews Summary';
      titleElement.style.cssText = 'color:#003580;font-weight:500;text-align:left';

      const scoreElement = document.createElement('div');
      scoreElement.style.display = 'inline-block';

      const scoreTitleWrapper = document.createElement('div');
      scoreTitleWrapper.style.cssText = 'display:flex;gap:10px';
      scoreTitleWrapper.appendChild(titleElement);
      scoreTitleWrapper.appendChild(scoreElement);

      const createDropdown = (options: string[], label: string) => {
        const select = document.createElement('select');
        select.style.cssText = 'padding:5px;border-radius:4px;width:100%';
        const optionEls = options.map(o => {
          const opt = document.createElement('option');
          opt.value = o;
          opt.textContent = o;
          return opt;
        });
        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.textContent = label;
        select.appendChild(defaultOpt);
        optionEls.forEach(opt => select.appendChild(opt));
        return select;
      };

      const customerTypeDropdown = createDropdown(customerTypes, 'All guest types');
      const roomTypeDropdown = createDropdown(roomTypes, 'All room types');

      const reviewCountElement = document.createElement('div');
      reviewCountElement.style.cssText = 'font-size:12px;color:#6B6B6B;margin-top:5px';

      const getColorForPercentage = (percentage: number) => {
        if (percentage < 50) return `hsl(0, 80%, 30%)`;
        if (percentage < 65) return `hsl(45, 80%, 35%)`;
        const lightness = Math.min(30 + (percentage - 65) * 0.5, 40);
        return `hsl(120, 70%, ${lightness}%)`;
      };

      const calculateScore = (customerType?: string, roomType?: string) => {
        const filteredReviews = allReviews.filter(
          (r: any) => (!customerType || r.bookingDetails.customerType === customerType) &&
            (!roomType || r.bookingDetails.roomType.name === roomType)
        );
        const score = filteredReviews.reduce((acc: number, r: any) => {
          if (r.reviewScore >= 9) return acc + 1;
          if (r.reviewScore <= 2) return acc - 1;
          return acc;
        }, 0);
        const percentage = ((score / filteredReviews.length) * 100).toFixed(0);
        scoreElement.textContent = `${percentage}% positive`;
        scoreElement.style.color = getColorForPercentage(Number(percentage));
        reviewCountElement.textContent = `Based on ${filteredReviews.length} reviews`;
      };

      calculateScore();

      [customerTypeDropdown, roomTypeDropdown].forEach(dd => {
        dd.addEventListener('change', () => calculateScore(customerTypeDropdown.value, roomTypeDropdown.value));
      });

      wrapperElement.appendChild(scoreTitleWrapper);
      wrapperElement.appendChild(reviewCountElement);
      wrapperElement.appendChild(customerTypeDropdown);
      wrapperElement.appendChild(roomTypeDropdown);

      document.querySelector('#js--hp-gallery-scorecard')?.appendChild(wrapperElement);
    })
    .catch(error => console.error('Error:', error));
});
